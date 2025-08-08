require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bodyParser = require("body-parser");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const WebSocket = require("ws");
const rateLimit = require("express-rate-limit");
const validator = require("validator");
const axios = require("axios");
const admin = require("firebase-admin");
const { initializeApp, cert } = require("firebase-admin/app");
const { getFirestore, FieldValue, FieldPath } = require("firebase-admin/firestore");
const https = require("https");
const fs = require("fs");
const onlineUsers = {};

// Generate SSL certificates if missing (for development)
try {
  if (!fs.existsSync('key.pem') || !fs.existsSync('cert.pem')) {
    const { execSync } = require('child_process');
    execSync('openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"');
    console.log("✅ Generated self-signed SSL certificates");
  }
} catch (e) {
  console.error("❌ SSL certificate generation failed:", e.message);
}

// 🔥 FIXED: Proper Firebase initialization with error handling
try {
  const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
  initializeApp({
  credential: cert(serviceAccount),
  databaseURL: process.env.FIREBASE_DATABASE_URL,
});
  console.log("✅ Firebase initialized successfully");
} catch (error) {
  console.error("❌ Firebase initialization failed:", error);
  process.exit(1);
}

const db = getFirestore();
const app = express();

app.use(cors({ origin: "*", credentials: true }));
app.use(bodyParser.json());
app.use(express.static("public"));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET is not set in .env");
  process.exit(1);
}

// 🔌 HTTPS Server Setup
const server = https.createServer({
  key: fs.readFileSync('key.pem'),
  cert: fs.readFileSync('cert.pem')
}, app);

// 🔌 WebSocket Setup
const wss = new WebSocket.Server({
  server,
  path: '/ws',
  clientTracking: true
});
const io = require('socket.io')(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST']
  }
});
io.on("connection", (socket) => {
  console.log(`🔌 New connection: ${socket.id}`);

  socket.on("authenticate", (token) => {
    try {
      const decoded = jwt.verify(token, JWT_SECRET);
      socket.user = decoded;
      onlineUsers[decoded.email] = socket.id;

      console.log(`✅ Authenticated: ${decoded.email}`);
      socket.emit("authenticated", { email: decoded.email });

    } catch (error) {
      console.log("❌ Authentication failed:", error.message);
      socket.emit("authentication_error", { message: "Invalid token" });
    }
  });

//const onlineUsers = new Map();
const callRooms = new Map();
const typingIndicators = new Map();

function noop() {}
function heartbeat() {
  this.isAlive = true;
}

function getChatId(email1, email2) {
  return [email1, email2].sort().join("_");
}

// 🧠 ChatGPT Translation Helper
async function translateWithChatGPT(text, targetLang = "hi") {
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) throw new Error("OpenAI API key not set");

  const response = await axios.post(
    "https://api.openai.com/v1/chat/completions",
    {
      model: "gpt-3.5-turbo",
      messages: [
        {
          role: "system",
          content: `You are a translation assistant. Automatically detect the source language and translate the message into ${targetLang}. Respond only with the translated text.`,
        },
        {
          role: "user",
          content: text,
        },
      ],
    },
    {
      headers: {
        Authorization: `Bearer ${OPENAI_API_KEY}`,
        "Content-Type": "application/json",
      },
    }
  );

  return response.data.choices[0].message.content.trim();
}

// 🏷️ Presence tracking for group members
async function updateGroupPresence(groupId, email, isJoining) {
  try {
    await db.collection('groups').doc(groupId).update({
      'activeMembers': isJoining
        ? FieldValue.arrayUnion([email])
        : FieldValue.arrayRemove([email]),
    });
  } catch (error) {
    console.error("❌ Group presence update error:", error);
  }
}

// 🛠️ WebSocket Message Handlers
async function handleWebRTCMessage(ws, payload) {
  try {
    const { roomId, signal, targetUser, type } = payload;

    // Validate required fields
    if (!roomId) {
      console.error('❌ Missing roomId in WebRTC message');
      return;
    }

    // Initialize room if it doesn't exist
    if (!callRooms.has(roomId)) {
      callRooms.set(roomId, new Set());
      console.log(`🆕 Created new room: ${roomId}`);
    }

    const room = callRooms.get(roomId);

    // Add user to room if not present
    if (!room.has(ws.user.email)) {
      room.add(ws.user.email);
      console.log(`👤 ${ws.user.email} joined room ${roomId}`);
    }

    // Handle different WebRTC signal types
    switch (type) {
      case 'offer':
      case 'answer':
        // Forward offers/answers to specific target
        if (!targetUser) {
          console.error('❌ Missing targetUser for offer/answer');
          return;
        }
        await forwardSignal({
          type,
          roomId,
          signal,
          sender: ws.user.email,
          targetUser
        });
        break;

      case 'ice-candidate':
        // Forward ICE candidates
        if (!targetUser) {
          console.error('❌ Missing targetUser for ICE candidate');
          return;
        }
        await forwardICECandidate({
          candidate: signal,
          sender: ws.user.email,
          targetUser
        });
        break;

      case 'hangup':
        await handleCallHangup(ws.user.email, roomId);
        break;

      default:
        console.error(`❌ Unknown WebRTC message type: ${type}`);
    }

    // Broadcast participant list to all in room
    await broadcastParticipants(roomId, room);

  } catch (error) {
    console.error('❌ Error in handleWebRTCMessage:', error);
    // Notify sender of failure
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({
        type: 'webrtc-error',
        error: 'Failed to process signaling message'
      }));
    }
  }
}

// Helper Functions

async function forwardSignal({ type, roomId, signal, sender, targetUser }) {
  const targetClient = onlineUsers.get(targetUser);

  if (!targetClient || targetClient.readyState !== WebSocket.OPEN) {
    console.error(`❌ Target ${targetUser} not available`);
    throw new Error('Target user not connected');
  }

  targetClient.send(JSON.stringify({
    type,
    roomId,
    signal,
    sender
  }));

  console.log(`📤 Forwarded ${type} from ${sender} to ${targetUser}`);
}

async function forwardICECandidate({ candidate, sender, targetUser }) {
  const targetClient = onlineUsers.get(targetUser);

  if (!targetClient || targetClient.readyState !== WebSocket.OPEN) {
    console.error(`❌ Target ${targetUser} not available for ICE candidate`);
    return; // ICE candidates are optional, don't throw error
  }

  targetClient.send(JSON.stringify({
    type: 'ice-candidate',
    candidate,
    sender
  }));

  console.log(`🧊 Forwarded ICE candidate from ${sender} to ${targetUser}`);
}

async function broadcastParticipants(roomId, room) {
  const participants = Array.from(room);

  room.forEach(email => {
    const client = onlineUsers.get(email);
    if (client?.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'callParticipants',
        roomId,
        participants,
        timestamp: Date.now()
      }));
    }
  });

  console.log(`📢 Room ${roomId} participants: ${participants.join(', ')}`);
}

async function handleCallHangup(userEmail, roomId) {
  if (!callRooms.has(roomId)) return;

  const room = callRooms.get(roomId);
  room.delete(userEmail);

  // Notify remaining participants
  room.forEach(email => {
    const client = onlineUsers.get(email);
    if (client?.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify({
        type: 'callHangup',
        roomId,
        participantLeft: userEmail,
        remainingParticipants: Array.from(room)
      }));
    }
  });

  // Clean up empty rooms
  if (room.size === 0) {
    callRooms.delete(roomId);
    console.log(`🗑️ Room ${roomId} cleaned up (no participants)`);
  } else {
    console.log(`👋 ${userEmail} left room ${roomId}`);
  }
}

async function handleHangupMessage(ws, payload) {
  const { roomId } = payload;
  if (callRooms.has(roomId)) {
    const room = callRooms.get(roomId);
    room.delete(ws.user.email);

    // Notify remaining participants
    room.forEach(email => {
      const client = onlineUsers.get(email);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'callHangup',
          roomId,
          participantLeft: ws.user.email
        }));
      }
    });

    // Clean up empty rooms
    if (room.size === 0) {
      callRooms.delete(roomId);
    }
  }
}

async function handleTypingIndicator(ws, payload) {
  const { isTyping, receiverEmail, isGroup } = payload;
  const senderEmail = ws.user.email;
  typingIndicators.set(senderEmail, isTyping ? Date.now() : null);

  // Broadcast typing status to group members
  if (isGroup) {
    const groupDoc = await db.collection('groups').doc(receiverEmail).get();
    const members = groupDoc.data()?.members || [];

    wss.clients.forEach(client => {
      if (
        client.readyState === WebSocket.OPEN &&
        client.user &&
        members.includes(client.user.email) &&
        client.user.email !== senderEmail
      ) {
        client.send(JSON.stringify({
          type: "typing",
          sender: senderEmail,
          groupId: receiverEmail,
          isTyping
        }));
      }
    });
  }
}

async function handleReaction(ws, payload) {
  const { emoji, messageId, receiverEmail, isGroup } = payload;
  const senderEmail = ws.user.email;
  const collectionPath = isGroup ? 'groups' : 'private_chats';
  const chatId = isGroup ? receiverEmail : getChatId(senderEmail, receiverEmail);

  const messageRef = db
    .collection(collectionPath)
    .doc(chatId)
    .collection("messages")
    .doc(messageId);

  const messageDoc = await messageRef.get();
  if (!messageDoc.exists) return;

  const reactions = messageDoc.data().reactions || {};

  // Toggle reaction
  if (reactions[senderEmail] === emoji) {
    delete reactions[senderEmail];
  } else {
    reactions[senderEmail] = emoji;
  }

  await messageRef.update({ reactions });

  // Broadcast reaction update
  const broadcast = {
    type: "reaction",
    messageId,
    chatId,
    reactions,
    sender: senderEmail,
    isGroup
  };

  if (isGroup) {
    const groupDoc = await db.collection('groups').doc(receiverEmail).get();
    const members = groupDoc.data()?.members || [];

    wss.clients.forEach(client => {
      if (
        client.readyState === WebSocket.OPEN &&
        client.user &&
        members.includes(client.user.email) // ✅ THIS LINE was missing a closing parenthesis!
      ) {
        client.send(JSON.stringify(broadcast));
      }
    });
    } else {
      wss.clients.forEach(client => {
        if (
          client.readyState === WebSocket.OPEN &&
          client.user &&
          [senderEmail, receiverEmail].includes(client.user.email) // ✅ Also check this line
        ) {
          client.send(JSON.stringify(broadcast));
        }
      });
    }
}

async function handleNewMessage(ws, payload) {
  const {
    text,
    receiverEmail,
    imageUrl,
    translate,
    targetLang = "hi",
    isGroup,
    isSystem
  } = payload;

  const senderEmail = ws.user.email;
  const chatId = isGroup ? receiverEmail : getChatId(senderEmail, receiverEmail);
  const collectionPath = isGroup ? 'groups' : 'private_chats';
  const serverTimestamp = admin.firestore.Timestamp.now();

  const message = {
    senderEmail: senderEmail,
    timestamp: serverTimestamp,
    deletedFor: [],
    seenBy: [],
    isGroup: isGroup || false,
    reactions: {},
    isSystem: isSystem || false
  };

  if (isGroup) {
    message.groupId = receiverEmail;
  } else {
    message.receiver = receiverEmail;
  }

  if (text) {
    message.text = text.trim();
    message.edited = false;

    if (translate === true) {
      try {
        const translated = await translateWithChatGPT(text.trim(), targetLang);
        message.translatedText = translated;
      } catch (err) {
        console.error("❌ Translation failed:", err.message);
      }
    }
  }

  if (imageUrl) {
    message.imageUrl = imageUrl;
  }

  const ref = await db
    .collection(collectionPath)
    .doc(chatId)
    .collection("messages")
    .add(message);

  const broadcast = {
    type: "message",
    id: ref.id,
    chatId,
    sender: senderEmail,
    text: text?.trim() || null,
    translatedText: message.translatedText || null,
    imageUrl: imageUrl || null,
    timestamp: serverTimestamp.toDate().toISOString(),
    isGroup: isGroup || false,
    isSystem: isSystem || false
  };

  if (isGroup) {
    // Group chat - update recent chats for all members
    const groupDoc = await db.collection('groups').doc(receiverEmail).get();
    const groupData = groupDoc.data();
    const members = groupData?.members || [];

    const batch = db.batch();
    const recentData = {
      email: receiverEmail,
      lastMessage: imageUrl ? "📷 Image" : text.trim(),
      timestamp: serverTimestamp,
      seen: false,
      senderEmail: senderEmail,
      isGroup: true,
      members: members,
      groupName: groupData?.name || receiverEmail,
    };

    members.forEach(member => {
      const memberRef = db
        .collection('recent_chats')
        .doc(member)
        .collection('chats')
        .doc(receiverEmail);
      batch.set(memberRef, recentData, { merge: true });
    });

    await batch.commit();

    // Send to all online group members
    wss.clients.forEach(client => {
      if (
        client.readyState === WebSocket.OPEN &&
        client.user &&
        members.includes(client.user.email))
      {
        client.send(JSON.stringify(broadcast));
      }
    });
  } else {
    // Private chat - standard handling
    const recentDataForSender = {
      email: receiverEmail,
      lastMessage: imageUrl ? "📷 Image" : text.trim(),
      timestamp: serverTimestamp,
      seen: true,
      senderEmail: senderEmail,
    };

    const recentDataForReceiver = {
      email: senderEmail,
      lastMessage: imageUrl ? "📷 Image" : text.trim(),
      timestamp: serverTimestamp,
      seen: false,
      senderEmail: senderEmail,
    };

    await db
      .collection("recent_chats")
      .doc(senderEmail)
      .collection("chats")
      .doc(receiverEmail)
      .set(recentDataForSender, { merge: true });

    await db
      .collection("recent_chats")
      .doc(receiverEmail)
      .collection("chats")
      .doc(senderEmail)
      .set(recentDataForReceiver, { merge: true });

    // Send to both private chat participants
    wss.clients.forEach(client => {
      if (
        client.readyState === WebSocket.OPEN &&
        client.user &&
        [senderEmail, receiverEmail].includes(client.user.email))
      {
        client.send(JSON.stringify(broadcast));
      }
    });
  }
}
// Add this before wss.on('connection')
wss.on('headers', (headers, req) => {
  headers.push('Access-Control-Allow-Origin: *');
  headers.push('Access-Control-Allow-Credentials: true');
});

wss.on("connection", (ws, req) => {
  console.log(`🔌 New connection attempt from ${req.socket.remoteAddress}`);
  ws.on('close', () => console.log(`🔌 Disconnected: ${ws.user?.email}`));

  const url = new URL(req.url, `https://${req.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    console.log("❌ WebSocket rejected: No token");
    return ws.close();
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    ws.user = decoded;
    onlineUsers.set(decoded.email, ws);
    ws.isAlive = true;
    ws.on("pong", heartbeat);
    console.log(`✅ WebSocket connected: ${decoded.email}`);

    // Update presence for any groups the user belongs to
    db.collection('groups')
      .where('members', 'array-contains', decoded.email)
      .get()
      .then(snapshot => {
        snapshot.forEach(doc => {
          updateGroupPresence(doc.id, decoded.email, true);
        });
      });

  } catch (error) {
    console.log("❌ Invalid WebSocket token:", error.message);
    return ws.close();
  }
  socket.on('startPrivateCall', async ({ callerEmail, receiverEmail }) => {
     const callRef = db.collection('calls').doc();
     await callRef.set({
       caller: callerEmail,
       receiver: receiverEmail,
       status: 'ringing',
       startedAt: FieldValue.serverTimestamp(),
       chatId: getChatId(callerEmail, receiverEmail)
     });

     // Notify receiver
     if (onlineUsers[receiverEmail]) {
       io.to(onlineUsers[receiverEmail]).emit('incomingCall', {
         callId: callRef.id,
         callerEmail,
       });
     }
   });

   socket.on('answerCall', async ({ callId }) => {
     const callRef = db.collection('calls').doc(callId);
     await callRef.update({
       status: 'answered', // Was 'accepted'
       answeredAt: FieldValue.serverTimestamp()
     });
   });

   socket.on('rejectCall', async ({ callId }) => {
     const callRef = db.collection('calls').doc(callId);
     await callRef.update({
       status: 'rejected',
       endedAt: FieldValue.serverTimestamp()
     });
   });
socket.on('endCall', async ({ callId }) => {
    const callRef = db.collection('calls').doc(callId);
    await callRef.update({
      status: 'ended',
      endedAt: FieldValue.serverTimestamp()
    });
  });

  socket.on('cancelCall', async ({ callId }) => {
    const callRef = db.collection('calls').doc(callId);
    await callRef.update({
      status: 'cancelled',
      endedAt: FieldValue.serverTimestamp()
    });
  });


socket.on('userConnected', (email) => {
  onlineUsers[email] = socket.id;
});

socket.on('disconnect', () => {
    if (socket.user?.email) {
      delete onlineUsers[socket.user.email];
      console.log(`🔌 Disconnected: ${socket.user.email}`);
    }
  });
  });
// Group Call - Start a new group call
socket.on('startGroupCall', async ({ callerEmail, groupId, participantEmails }) => {
  const callRef = firestore.collection('group_calls').doc();

  await callRef.set({
    caller: callerEmail,
    groupId,
    participants: participantEmails,
    status: 'ringing',
    startedAt: admin.firestore.FieldValue.serverTimestamp(),
  });

  // Notify online participants
  participantEmails.forEach((email) => {
    const socketId = onlineUsers[email];
    if (socketId && email !== callerEmail) {
      io.to(socketId).emit('incomingGroupCall', {
        callId: callRef.id,
        groupId,
        callerEmail,
      });
    }
  });
});

// Group Call - Join an existing group call
socket.on('joinGroupCall', async ({ callId, userEmail }) => {
  const callRef = firestore.collection('group_calls').doc(callId);
  await callRef.update({
    [`joined.${userEmail}`]: true,
  });
});

// Group Call - Leave the group call
socket.on('leaveGroupCall', async ({ callId, userEmail }) => {
  const callRef = firestore.collection('group_calls').doc(callId);
  await callRef.update({
    [`joined.${userEmail}`]: false,
  });
});

// Group Call - End the group call for all
socket.on('endGroupCall', async ({ callId }) => {
  const callRef = firestore.collection('group_calls').doc(callId);
  await callRef.update({ status: 'ended' });
});

// Group Call - Cancel the call before answer
socket.on('cancelGroupCall', async ({ callId }) => {
  const callRef = firestore.collection('group_calls').doc(callId);
  await callRef.update({ status: 'cancelled' });
});


  ws.on("message", async (data) => {
    try {
      const payload = JSON.parse(data);

      // Handle different message types
      if (payload.type === 'webrtc') {
        await handleWebRTCMessage(ws, payload);
      }
      else if (payload.type === 'hangup') {
        await handleHangupMessage(ws, payload);
      }
      else if (payload.isTyping !== undefined) {
        await handleTypingIndicator(ws, payload);
      }
      else if (payload.emoji && payload.messageId) {
        await handleReaction(ws, payload);
      }
      else if (payload.text || payload.imageUrl) {
        await handleNewMessage(ws, payload);
      }
    } catch (error) {
      console.error("❌ WebSocket Error:", error.message);
    }
  });

  ws.on("error", (error) => {
    console.error(`❌ WebSocket error for ${ws.user?.email}:`, error.message);
  });

  ws.on("close", () => {
    const userEmail = ws.user?.email;
    if (userEmail) {
      onlineUsers.delete(userEmail);
      typingIndicators.delete(userEmail);
      console.log(`🔌 WebSocket disconnected: ${userEmail}`);

      // Clean up any call rooms this user was in
      callRooms.forEach((participants, roomId) => {
        if (participants.has(userEmail)) {
          participants.delete(userEmail);

          // Notify remaining participants
          participants.forEach(email => {
            const client = onlineUsers.get(email);
            if (client && client.readyState === WebSocket.OPEN) {
              client.send(JSON.stringify({
                type: 'callHangup',
                roomId,
                participantLeft: userEmail
              }));
            }
          });

          // Clean up empty rooms
          if (participants.size === 0) {
            callRooms.delete(roomId);
          }
        }
      });

      // Update presence for any groups the user belongs to
      db.collection('groups')
        .where('members', 'array-contains', userEmail)
        .get()
        .then(snapshot => {
          snapshot.forEach(doc => {
            updateGroupPresence(doc.id, userEmail, false);
          });
        });
    }
  });
});

setInterval(() => {
  wss.clients.forEach((ws) => {
    if (!ws.isAlive) {
      console.log(`♻️ Terminating inactive connection: ${ws.user?.email || 'unknown'}`);
      return ws.terminate();
    }
    ws.isAlive = false;
    ws.ping(noop);
  });

  // Cleanup expired typing indicators (10s threshold)
  const typingIndicators = new Map();
  const now = Date.now();
  typingIndicators.forEach((timestamp, email) => {
    if (timestamp && now - timestamp > 10000) {
      typingIndicators.set(email, null);
    }
  });
}, 30000);

// 🔐 Authentication Middleware
const verifyToken = (req, res, next) => {
  const token = req.header("Authorization")?.split(" ")[1];
  if (!token) {
    return res.status(401).json({ success: false, message: "❌ No token provided!" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, message: "❌ Invalid token!" });
  }
};

const messageLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  message: { success: false, message: "❌ Too many messages sent, slow down!" },
});

// 🔥 Firebase Authentication Routes
app.post("/google-signin", async (req, res) => {
  const { idToken } = req.body;

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    const email = decodedToken.email;

    const snapshot = await db.collection("users").where("email", "==", email).get();
    if (snapshot.empty) {
      await db.collection("users").add({
        username: decodedToken.name || "",
        email: email,
        profilePic: decodedToken.picture || "",
        createdAt: FieldValue.serverTimestamp(),
      });
    }

    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: "2h" });
    return res.json({ success: true, token });
  } catch (err) {
    console.error("❌ Google Sign-In verify failed:", err.message);
    return res.status(401).json({ success: false, message: "❌ Invalid Google ID token!" });
  }
});

// 🔥 FIXED: Registration endpoint with proper Firestore permissions
app.post("/register", async (req, res) => {
  let { username, email, password } = req.body;
  username = username?.trim();
  email = validator.normalizeEmail(email || "");
  password = password?.trim();

  if (!username || !email || !password) {
    return res.status(400).json({ success: false, message: "❌ All fields are required!" });
  }

  if (!validator.isEmail(email)) {
    return res.status(400).json({ success: false, message: "❌ Invalid email format!" });
  }

  if (password.length < 8) {
    return res.status(400).json({ success: false, message: "❌ Password too short!" });
  }

  try {
    const snapshot = await db.collection("users").where("email", "==", email).get();
    if (!snapshot.empty) {
      return res.status(400).json({ success: false, message: "❌ Email already registered!" });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    await db.collection("users").add({
      username,
      email,
      password: hashedPassword,
      createdAt: FieldValue.serverTimestamp()
    });

    res.status(201).json({ success: true, message: "✅ User registered!" });
  } catch (error) {
    console.error("❌ Registration Error:", error);
    res.status(500).json({
      success: false,
      message: "❌ Server error!",
      errorDetails: error.message // Added for debugging
    });
  }
});

app.post("/login", async (req, res) => {
  const email = validator.normalizeEmail(req.body.email || "");
  const password = req.body.password?.trim();

  if (!email || !password) {
    return res.status(400).json({ success: false, message: "❌ All fields are required!" });
  }

  try {
    const snapshot = await db.collection("users").where("email", "==", email).get();
    if (snapshot.empty) {
      return res.status(401).json({ success: false, message: "❌ Invalid email or password!" });
    }

    const userDoc = snapshot.docs[0];
    const user = userDoc.data();

    const isPasswordValid = await bcrypt.compare(password, user.password);
    if (!isPasswordValid) {
      return res.status(401).json({ success: false, message: "❌ Invalid credentials!" });
    }

    const token = jwt.sign({ email, userId: userDoc.id }, JWT_SECRET, {
      expiresIn: "2h",
    });

    res.status(200).json({ success: true, message: "✅ Login successful!", token });
  } catch (error) {
    console.error("❌ Login Error:", error.message);
    res.status(500).json({ success: false, message: "❌ Server error!" });
  }
});

// 📁 File Upload Handling
const multer = require("multer");
const upload = multer({ dest: "public/uploads/" });

app.post("/upload-image", upload.single("image"), (req, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ success: false, message: "No file uploaded." });

  const imageUrl = `${req.protocol}://${req.get("host")}/uploads/${file.filename}`;
  res.json({ success: true, imageUrl });
});

// 🔍 Search Endpoints
app.get("/search-users", verifyToken, async (req, res) => {
  try {
    const { query } = req.query;
    const userEmail = req.user.email;

    if (!query || query.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Search query must be at least 2 characters"
      });
    }

    const lowercaseQuery = query.toLowerCase();

    // Search users (excluding current user)
    const usersSnapshot = await db.collection('users')
      .where('email', '>=', lowercaseQuery)
      .where('email', '<=', lowercaseQuery + '\uf8ff')
      .limit(10)
      .get();

    // Search groups
    const groupsSnapshot = await db.collection('groups')
      .where(FieldPath.documentId(), '>=', lowercaseQuery)
      .where(FieldPath.documentId(), '<=', lowercaseQuery + '\uf8ff')
      .limit(10)
      .get();

    const results = {
      users: usersSnapshot.docs
        .filter(doc => doc.data().email !== userEmail)
        .map(doc => ({
          id: doc.id,
          email: doc.data().email,
          username: doc.data().username,
          profilePic: doc.data().profilePic
        })),
      groups: groupsSnapshot.docs.map(doc => ({
        id: doc.id,
        name: doc.data().name,
        members: doc.data().members
      }))
    };

    res.status(200).json({
      success: true,
      data: results
    });
  } catch (error) {
    console.error("❌ Search error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to perform search"
    });
  }
});

app.post("/start-chat", verifyToken, async (req, res) => {
  try {
    const { targetEmail, isGroup } = req.body;
    const userEmail = req.user.email;

    if (!targetEmail) {
      return res.status(400).json({
        success: false,
        message: "Target email or group ID is required"
      });
    }

    if (isGroup) {
      // Handle group chat
      const groupDoc = await db.collection('groups').doc(targetEmail).get();

      if (!groupDoc.exists) {
        return res.status(404).json({
          success: false,
          message: "Group not found"
        });
      }

      const groupData = groupDoc.data();

      if (!groupData.members.includes(userEmail)) {
        return res.status(403).json({
          success: false,
          message: "You are not a member of this group"
        });
      }

      // Create recent chat entry
      const recentData = {
        email: targetEmail,
        lastMessage: "Group chat started",
        timestamp: FieldValue.serverTimestamp(),
        seen: true,
        isGroup: true,
        groupName: groupData.name,
        members: groupData.members
      };

      await db.collection('recent_chats')
        .doc(userEmail)
        .collection('chats')
        .doc(targetEmail)
        .set(recentData, { merge: true });

      res.status(200).json({
        success: true,
        message: "Group added to recent chats",
        chatId: targetEmail
      });
    } else {
      // Handle private chat
      if (targetEmail === userEmail) {
        return res.status(400).json({
          success: false,
          message: "Cannot start chat with yourself"
        });
      }

      // Check if user exists
      const userSnapshot = await db.collection('users')
        .where('email', '==', targetEmail)
        .get();

      if (userSnapshot.empty) {
        return res.status(404).json({
          success: false,
          message: "User not found"
        });
      }

      // Create recent chat entry for both users
      const chatId = getChatId(userEmail, targetEmail);

      const recentDataForCurrentUser = {
        email: targetEmail,
        lastMessage: "Chat started",
        timestamp: FieldValue.serverTimestamp(),
        seen: true,
        senderEmail: userEmail
      };

      const recentDataForTargetUser = {
        email: userEmail,
        lastMessage: "Chat started",
        timestamp: FieldValue.serverTimestamp(),
        seen: false,
        senderEmail: userEmail
      };

      // Create chat document
      await db.collection('private_chats').doc(chatId).set({
        participants: [userEmail, targetEmail],
        createdAt: FieldValue.serverTimestamp()
      });

      // Add to recent chats
      await db.collection('recent_chats')
        .doc(userEmail)
        .collection('chats')
        .doc(targetEmail)
        .set(recentDataForCurrentUser, { merge: true });

      await db.collection('recent_chats')
        .doc(targetEmail)
        .collection('chats')
        .doc(userEmail)
        .set(recentDataForTargetUser, { merge: true });

      res.status(200).json({
        success: true,
        message: "Chat started successfully",
        chatId
      });
    }
  } catch (error) {
    console.error("❌ Start chat error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to start chat"
    });
  }
});

// 💬 Message Routes
app.get("/messages/:receiverEmail", verifyToken, async (req, res) => {
  const sender = req.user.email;
  const receiver = req.params.receiverEmail;
  const chatId = getChatId(sender, receiver);

  try {
    const snapshot = await db
      .collection("private_chats")
      .doc(chatId)
      .collection("messages")
      .orderBy("timestamp", "asc")
      .get();

    const messages = snapshot.docs.map((doc) => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ success: true, data: messages });
  } catch (error) {
    console.error("❌ Fetch Messages Error:", error.message);
    res.status(500).json({ success: false, message: "❌ Failed to fetch messages!" });
  }
});

// 🏘️ Group Chat Routes
app.post("/create-group", verifyToken, async (req, res) => {
  try {
    const { groupName, members } = req.body;
    const creatorEmail = req.user.email;

    if (!groupName || !members || members.length < 2) {
      return res.status(400).json({
        success: false,
        message: "Group name and at least 2 members are required"
      });
    }

    // Check if group name already exists
    const groupExists = await db.collection('groups').doc(groupName).get();
    if (groupExists.exists) {
      return res.status(400).json({
        success: false,
        message: "Group name already exists"
      });
    }

    const allMembers = [...new Set([...members, creatorEmail])]; // Remove duplicates
    const groupData = {
      name: groupName,
      members: allMembers,
      createdBy: creatorEmail,
      admin: creatorEmail, // Set creator as admin
      createdAt: FieldValue.serverTimestamp(),
      activeMembers: [creatorEmail],
      pinned: true // Automatically pin for all members
    };

    await db.collection('groups').doc(groupName).set(groupData);

    // Add to recent chats for all members (automatically pinned)
    const batch = db.batch();
    const recentData = {
      email: groupName,
      lastMessage: "Group created",
      timestamp: FieldValue.serverTimestamp(),
      seen: false,
      isGroup: true,
      members: allMembers,
      pinned: true, // This will pin the group for all members
      pinnedAt: FieldValue.serverTimestamp()
    };

    allMembers.forEach(member => {
      const memberRef = db
        .collection('recent_chats')
        .doc(member)
        .collection('chats')
        .doc(groupName);
      batch.set(memberRef, recentData, { merge: true });
    });

    await batch.commit();

    // Notify all members about the new group
    const notification = {
      type: "group_created",
      groupId: groupName,
      groupName: groupName,
      createdBy: creatorEmail,
      timestamp: FieldValue.serverTimestamp()
    };

    const notifyBatch = db.batch();
    allMembers.forEach(member => {
      if (member !== creatorEmail) {
        const notificationRef = db
          .collection('notifications')
          .doc(member)
          .collection('items')
          .doc();
        notifyBatch.set(notificationRef, notification);
      }
    });
    await notifyBatch.commit();

    res.status(201).json({
      success: true,
      message: "Group created successfully",
      groupId: groupName
    });
  } catch (error) {
    console.error("❌ Group creation error:", error);
    res.status(500).json({ success: false, message: "Failed to create group" });
  }
});

app.post("/add-group-members", verifyToken, async (req, res) => {
  try {
    const { groupId, newMembers } = req.body;
    const userEmail = req.user.email;

    if (!groupId || !newMembers || newMembers.length === 0) {
      return res.status(400).json({
        success: false,
        message: "Group ID and at least one new member required"
      });
    }

    const groupDoc = await db.collection('groups').doc(groupId).get();
    if (!groupDoc.exists) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    const groupData = groupDoc.data();
    if (groupData.admin !== userEmail) {
      return res.status(403).json({
        success: false,
        message: "Only group admin can add members"
      });
    }

    // Filter out members already in group
    const uniqueNewMembers = newMembers.filter(
      email => !groupData.members.includes(email)
    );

    if (uniqueNewMembers.length === 0) {
      return res.status(400).json({
        success: false,
        message: "All specified members are already in the group"
      });
    }

    // Update group members
    await db.collection('groups').doc(groupId).update({
      members: FieldValue.arrayUnion(...uniqueNewMembers)
    });

    // Add pinned group to new members' recent chats
    const batch = db.batch();
    const recentData = {
      email: groupId,
      lastMessage: "You were added to the group",
      timestamp: FieldValue.serverTimestamp(),
      seen: false,
      isGroup: true,
      members: [...groupData.members, ...uniqueNewMembers],
      pinned: true, // Automatically pin for new members
      pinnedAt: FieldValue.serverTimestamp()
    };

    uniqueNewMembers.forEach(member => {
      const memberRef = db
        .collection('recent_chats')
        .doc(member)
        .collection('chats')
        .doc(groupId);
      batch.set(memberRef, recentData, { merge: true });
    });

    await batch.commit();

    // Notify new members
    const notification = {
      type: "added_to_group",
      groupId: groupId,
      groupName: groupData.name,
      addedBy: userEmail,
      timestamp: FieldValue.serverTimestamp()
    };

    const notifyBatch = db.batch();
    uniqueNewMembers.forEach(member => {
      const notificationRef = db
        .collection('notifications')
        .doc(member)
        .collection('items')
        .doc();
      notifyBatch.set(notificationRef, notification);
    });
    await notifyBatch.commit();

    // Add system message to group
    await db.collection('groups')
      .doc(groupId)
      .collection('messages')
      .add({
        text: `${userEmail} added ${uniqueNewMembers.join(', ')} to the group`,
        sender: 'System',
        timestamp: FieldValue.serverTimestamp(),
        isSystem: true
      });

    res.status(200).json({
      success: true,
      message: "Members added successfully",
      addedMembers: uniqueNewMembers
    });
  } catch (error) {
    console.error("❌ Add group members error:", error);
    res.status(500).json({ success: false, message: "Failed to add members" });
  }
});

app.post("/remove-group-member", verifyToken, async (req, res) => {
  try {
    const { groupId, memberEmail } = req.body;
    const userEmail = req.user.email;

    if (!groupId || !memberEmail) {
      return res.status(400).json({
        success: false,
        message: "Group ID and member email required"
      });
    }

    const groupDoc = await db.collection('groups').doc(groupId).get();
    if (!groupDoc.exists) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    const groupData = groupDoc.data();
    if (groupData.admin !== userEmail) {
      return res.status(403).json({
        success: false,
        message: "Only group admin can remove members"
      });
    }

    if (!groupData.members.includes(memberEmail)) {
      return res.status(400).json({
        success: false,
        message: "Member not in group"
      });
    }

    // Remove member from group
    await db.collection('groups').doc(groupId).update({
      members: FieldValue.arrayRemove([memberEmail])
    });

    // Remove group from member's recent chats
    await db.collection('recent_chats')
      .doc(memberEmail)
      .collection('chats')
      .doc(groupId)
      .delete

    // Add system message
    await db.collection('groups')
      .doc(groupId)
      .collection('messages')
      .add({
        text: `${userEmail} left the group`,
        sender: 'System',
        timestamp: FieldValue.serverTimestamp(),
        isSystem: true
      });

    res.status(200).json({
      success: true,
      message: "Left group successfully"
    });
  } catch (error) {
    console.error("❌ Leave group error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to leave group"
    });
  }
});
// Assuming Firebase Admin SDK is initialized as `admin`
app.post("/updateProfileImage", async (req, res) => {
  const { uid, imageUrl } = req.body;

  if (!uid || !imageUrl) {
    return res.status(400).json({ error: "Missing uid or imageUrl" });
  }

  try {
    await admin.firestore().collection("users").doc(uid).update({
      profileImage: imageUrl,
    });

    return res.status(200).json({ message: "Profile image updated" });
  } catch (error) {
    console.error("Error updating profile image:", error);
    return res.status(500).json({ error: "Failed to update image URL" });
  }
});

app.post("/toggle-pin-chat", verifyToken, async (req, res) => {
  try {
    const { chatId, isGroup } = req.body;
    const userEmail = req.user.email;

    if (!chatId) {
      return res.status(400).json({
        success: false,
        message: "Chat ID is required"
      });
    }

    const chatRef = db
      .collection('recent_chats')
      .doc(userEmail)
      .collection('chats')
      .doc(chatId);

    const chatDoc = await chatRef.get();
    if (!chatDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Chat not found"
      });
    }

    const currentData = chatDoc.data();
    const isPinned = currentData.pinned || false;

    await chatRef.update({
      pinned: !isPinned,
      pinnedAt: isPinned ? FieldValue.delete() : FieldValue.serverTimestamp()
    });

    res.status(200).json({
      success: true,
      message: `Chat ${!isPinned ? 'pinned' : 'unpinned'} successfully`,
      pinned: !isPinned
    });
  } catch (error) {
    console.error("❌ Toggle pin error:", error);
    res.status(500).json({ success: false, message: "Failed to toggle pin" });
  }
});

app.get("/group-messages/:groupId", verifyToken, async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const userEmail = req.user.email;

    // Verify user is a group member
    const groupDoc = await db.collection('groups').doc(groupId).get();
    if (!groupDoc.exists || !groupDoc.data().members.includes(userEmail)) {
      return res.status(403).json({ success: false, message: "Not a group member" });
    }

    const snapshot = await db
      .collection('groups')
      .doc(groupId)
      .collection('messages')
      .orderBy('timestamp', 'asc')
      .get();

    const messages = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
    }));

    res.status(200).json({ success: true, data: messages });
  } catch (error) {
    console.error("❌ Group messages error:", error);
    res.status(500).json({ success: false, message: "Failed to get group messages" });
  }
});

app.get("/group-info/:groupId", verifyToken, async (req, res) => {
  try {
    const groupId = req.params.groupId;
    const userEmail = req.user.email;

    const groupDoc = await db.collection('groups').doc(groupId).get();
    if (!groupDoc.exists) {
      return res.status(404).json({ success: false, message: "Group not found" });
    }

    const groupData = groupDoc.data();
    if (!groupData.members.includes(userEmail)) {
      return res.status(403).json({ success: false, message: "Not a group member" });
    }

    // Get user details for all members
    const membersSnapshot = await db.collection('users')
      .where('email', 'in', groupData.members)
      .get();

    const members = membersSnapshot.docs.map(doc => {
      const user = doc.data();
      return {
        email: user.email,
        username: user.username,
        profilePic: user.profilePic,
        isOnline: groupData.activeMembers?.includes(user.email) || false
      };
    });

    res.status(200).json({
      success: true,
      data: {
        name: groupData.name,
        createdBy: groupData.createdBy,
        admin: groupData.admin,
        createdAt: groupData.createdAt?.toDate(),
        members: members,
        activeMembers: groupData.activeMembers || []
      }
    });
  } catch (error) {
    console.error("❌ Group info error:", error);
    res.status(500).json({ success: false, message: "Failed to get group info" });
  }
});

// 🚀 Start Server
const PORT = process.env.PORT || 3000;

// Start the HTTPS server (which includes WebSocket)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`🚀 Server running on https://0.0.0.0:${PORT}`);
  console.log(`📱 WebSocket running on wss://0.0.0.0:${PORT}/ws`);
});
