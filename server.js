
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
const http = require("http");
const onlineUsers = new Map();

// 🔥 Firebase initialization with error handling
try {
  const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
  initializeApp({
    credential: cert(serviceAccount),
    databaseURL: process.env.FIREBASE_DATABASE_URL,
  });
  console.log("✅ Firebase initialized successfully");
} catch (error) {
  console.error("❌ Firebase initialization failed:", error);
  if (process.env.NODE_ENV !== 'production') process.exit(1);
}

const db = getFirestore();
const app = express();

app.use(cors({ origin: "*", credentials: true }));
app.use(bodyParser.json());
app.use(express.static("public"));

const JWT_SECRET = process.env.JWT_SECRET;
if (!JWT_SECRET) {
  console.error("❌ JWT_SECRET is not set in .env");
  if (process.env.NODE_ENV !== 'production') process.exit(1);
}

// 🔌 HTTP Server Setup (Render provides HTTPS termination)
const server = http.createServer(app);

// 🔌 WebSocket Setup
const wss = new WebSocket.Server({
  server,
  path: '/ws',
  clientTracking: true
});

const callRooms = new Map();
const typingIndicators = new Map();

function noop() {}
function heartbeat() {
  this.isAlive = true;
}

function getChatId(email1, email2) {
  return [email1, email2].sort().join("_");
}

async function setUserPresence(userEmail) {
  const userStatusDatabaseRef = realtimeDb.ref('/status/' + userEmail);
  const userStatusFirestoreRef = firestore.collection('online_status').doc(userEmail);

  const isOfflineForDatabase = {
    state: 'offline',
    last_changed: admin.database.ServerValue.TIMESTAMP,
  };
  const isOnlineForDatabase = {
    state: 'online',
    last_changed: admin.database.ServerValue.TIMESTAMP,
  };

  const isOfflineForFirestore = {
    isOnline: false,
    lastSeen: admin.firestore.FieldValue.serverTimestamp(),
  };
  const isOnlineForFirestore = {
    isOnline: true,
    lastSeen: null,
  };

  const connectedRef = realtimeDb.ref('.info/connected');
  connectedRef.on('value', async (snapshot) => {
    if (snapshot.val() === false) {
      await userStatusFirestoreRef.set(isOfflineForFirestore, { merge: true });
      return;
    }

    userStatusDatabaseRef.onDisconnect().set(isOfflineForDatabase).then(async () => {
      await userStatusDatabaseRef.set(isOnlineForDatabase);
      await userStatusFirestoreRef.set(isOnlineForFirestore, { merge: true });
    });
  });
}
// FCM helper
async function sendFCMNotification(token, title, body, data = {}) {
  try {
    const message = {
      token,
      notification: {
        title,
        body,
      },
      data, // custom payload (chatId, sender, etc.)
      android: {
        priority: "high",
      },
      apns: {
        payload: {
          aps: { sound: "default" },
        },
      },
    };

    await admin.messaging().send(message);
    console.log("✅ FCM sent to", token);
  } catch (err) {
    console.error("❌ FCM error:", err.message);
  }
}

async function sendFCMNotification(token, title, body, data) {
  try {
    const message = {
      notification: { title, body },
      data: data,
      token: token
    };

    const response = await admin.messaging().send(message);
    console.log('✅ Successfully sent FCM message:', response);
  } catch (error) {
    console.error('❌ Error sending FCM message:', error);
  }
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
        ? FieldValue.arrayUnion(email)
        : FieldValue.arrayRemove(email),
    });
  } catch (error) {
    console.error("❌ Group presence update error:", error);
  }
}


// 🛠️ WebSocket Message Handlers
// handleWebRTCMessage expecting signalType

// Forward Offer/Answer

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
        members.includes(client.user.email)
      ) {
        client.send(JSON.stringify(broadcast));
      }
    });
    } else {
      wss.clients.forEach(client => {
        if (
          client.readyState === WebSocket.OPEN &&
          client.user &&
          [senderEmail, receiverEmail].includes(client.user.email)
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
if (isGroup) {
  // Group: send notification to all except sender
  const groupDoc = await db.collection("groups").doc(receiverEmail).get();
  const groupData = groupDoc.data();
  const members = groupData?.members || [];

  for (const member of members) {
    if (member !== senderEmail) {
      const userDoc = await db.collection("users").doc(member).get();
      const token = userDoc.data()?.fcmToken;

      if (token) {
        await sendFCMNotification(
          token,
          `${groupData?.name || "Group"}: ${senderEmail}`,
          imageUrl ? "📷 Image" : text,
          { chatId, sender: senderEmail, isGroup: "true" }
        );
      }
    }
  }
} else {
  // Private chat
  const userDoc = await db.collection("users").doc(receiverEmail).get();
  const token = userDoc.data()?.fcmToken;

  if (token) {
    await sendFCMNotification(
      token,
      `New message from ${senderEmail}`,
      imageUrl ? "📷 Image" : text,
      { chatId, sender: senderEmail, isGroup: "false" }
    );
  }
}


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
    [senderEmail, receiverEmail].includes(client.user.email)
  ) {
    client.send(JSON.stringify(broadcast));
  }
});
  }
}

// Set headers for CORS
// Allow CORS headers for WebSocket upgrade requests
// Set headers for CORS on WebSocket upgrade requests
wss.on('headers', (headers, req) => {
  headers.push('Access-Control-Allow-Origin: *');
  headers.push('Access-Control-Allow-Credentials: true');
});

// Heartbeat function for WebSocket liveness
function heartbeat() {
  this.isAlive = true;
}
function noop() {}

// WebSocket connection handler
wss.on("connection", async (ws, req) => {
  console.log(`🔌 New connection attempt from ${req.socket.remoteAddress}`);
  const url = new URL(req.url, `http://${req.headers.host}`);
  const token = url.searchParams.get("token");

  if (!token) {
    console.log("❌ WebSocket rejected: No token");
    return ws.close();
  }

  try {
    // Verify Firebase ID token
    const decodedToken = await admin.auth().verifyIdToken(token);
    ws.user = decodedToken;
    onlineUsers.set(decodedToken.email, ws);

    ws.isAlive = true;
    ws.on("pong", heartbeat);
    console.log(`✅ WebSocket connected: ${decodedToken.email}`);

    // Update presence for groups
    db.collection('groups')
      .where('members', 'array-contains', decodedToken.email)
      .get()
      .then(snapshot => {
        snapshot.forEach(doc => {
          updateGroupPresence(doc.id, decodedToken.email, true);
        });
      });

    // Handle incoming WebSocket messages
   ws.on("message", async (data) => {
       try {
         const payload = JSON.parse(data);

         // Handle call-related messages
         if (payload.type === "call-joined") {
           // Notify other participants that someone joined
           const { roomId, userName } = payload;

           wss.clients.forEach(client => {
             if (client !== ws && client.readyState === WebSocket.OPEN) {
               client.send(JSON.stringify({
                 type: "participant-joined",
                 roomId: roomId,
                 userName: userName,
                 timestamp: Date.now()
               }));
             }
           });
         }
         else if (payload.type === "call-left") {
           // Notify other participants that someone left
           const { roomId, userName } = payload;

           wss.clients.forEach(client => {
             if (client !== ws && client.readyState === WebSocket.OPEN) {
               client.send(JSON.stringify({
                 type: "participant-left",
                 roomId: roomId,
                 userName: userName,
                 timestamp: Date.now()
               }));
             }
           });
         }

       } catch (error) {
         console.error("❌ WebSocket message error:", error);
       }
     });
    ws.on("error", (error) => {
      console.error(`❌ WebSocket error for ${ws.user?.email}:`, error.message);
    });

    // In WebSocket close handler, remove call room cleanup:
    ws.on("close", () => {
      const userEmail = ws.user?.email;
      if (!userEmail) return;

      onlineUsers.delete(userEmail);
      typingIndicators.delete(userEmail);
      console.log(`🔌 WebSocket disconnected: ${userEmail}`);

      // Keep group presence update:
      db.collection('groups')
        .where('members', 'array-contains', userEmail)
        .get()
        .then(snapshot => {
          snapshot.forEach(doc => {
            updateGroupPresence(doc.id, userEmail, false);
          });
        });
    }); // <-- This was missing

  } catch (error) {
    console.log("❌ Invalid Firebase token:", error.message);
    return ws.close();
  }
}); // <-- This was missing

// Add the call initiation endpoints AFTER the WebSocket connection handler
app.post("/initiate-call", verifyToken, async (req, res) => {
  try {
    const { targetEmail, isGroup } = req.body;
    const callerEmail = req.user.email;

    // Generate a unique room ID
    const roomId = `call_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // For group calls, notify all members
    if (isGroup) {
      const groupDoc = await db.collection('groups').doc(targetEmail).get();
      if (!groupDoc.exists) {
        return res.status(404).json({ success: false, message: "Group not found" });
      }

      const members = groupDoc.data().members || [];

      // Send notification to all group members
      members.forEach(member => {
        if (member !== callerEmail) {
          const client = onlineUsers.get(member);
          if (client && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify({
              type: 'call-invitation',
              roomId: roomId,
              caller: callerEmail,
              groupId: targetEmail,
              timestamp: Date.now()
            }));
          }
        }
      });
    } else {
      // For private calls, notify the specific user
      const client = onlineUsers.get(targetEmail);
      if (client && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify({
          type: 'call-invitation',
          roomId: roomId,
          caller: callerEmail,
          timestamp: Date.now()
        }));
      }
    }

    res.status(200).json({
      success: true,
      roomId: roomId,
      message: "Call initiated"
    });

  } catch (error) {
    console.error("❌ Call initiation error:", error);
    res.status(500).json({ success: false, message: "Failed to initiate call" });
  }
});

// Add a call response endpoint
app.post("/respond-to-call", verifyToken, async (req, res) => {
  try {
    const { roomId, accepted, callerEmail } = req.body;
    const responderEmail = req.user.email;

    if (accepted) {
      // Notify the caller that the call was accepted
      const callerClient = onlineUsers.get(callerEmail);
      if (callerClient && callerClient.readyState === WebSocket.OPEN) {
        callerClient.send(JSON.stringify({
          type: 'call-accepted',
          roomId: roomId,
          responder: responderEmail,
          timestamp: Date.now()
        }));
      }
    } else {
      // Notify the caller that the call was rejected
      const callerClient = onlineUsers.get(callerEmail);
      if (callerClient && callerClient.readyState === WebSocket.OPEN) {
        callerClient.send(JSON.stringify({
          type: 'call-rejected',
          roomId: roomId,
          responder: responderEmail,
          timestamp: Date.now()
        }));
      }
    }

    res.status(200).json({ success: true, message: "Call response sent" });

  } catch (error) {
    console.error("❌ Call response error:", error);
    res.status(500).json({ success: false, message: "Failed to respond to call" });
  }
}); // <-- This was missing

// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});
// Health check endpoint for Render
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'healthy' });
});

// Create a call room
app.post("/create-call-room", verifyToken, async (req, res) => {
  try {
    const { roomId, userName, userId } = req.body;
    const creatorEmail = req.user.email;

    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: "Room ID is required"
      });
    }

    // Create the call room in Firestore
    await db.collection("calls").doc(roomId).set({
      "roomId": roomId,
      "creator": creatorEmail,
      "creatorId": userId,
      "participants": [userId],
      "participantNames": [userName],
      "createdAt": admin.firestore.FieldValue.serverTimestamp(),
    });

    res.status(200).json({
      success: true,
      roomId: roomId,
      message: "Call room created successfully"
    });

  } catch (error) {
    console.error("❌ Create call room error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to create call room"
    });
  }
});

// Join a call room
app.post("/join-call-room", verifyToken, async (req, res) => {
  try {
    const { roomId, userName, userId } = req.body;
    const userEmail = req.user.email;

    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: "Room ID is required"
      });
    }

    // Check if room exists
    const roomDoc = await db.collection("calls").doc(roomId).get();
    if (!roomDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Call room not found"
      });
    }

    // Add user to the call room
    await db.collection("calls").doc(roomId).update({
      "participants": admin.firestore.FieldValue.arrayUnion(userId),
      "participantNames": admin.firestore.FieldValue.arrayUnion(userName),
    });

    res.status(200).json({
      success: true,
      roomId: roomId,
      message: "Joined call room successfully"
    });

  } catch (error) {
    console.error("❌ Join call room error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to join call room"
    });
  }
});

// Leave a call room
app.post("/leave-call-room", verifyToken, async (req, res) => {
  try {
    const { roomId, userId, userName, isHost } = req.body;
    const userEmail = req.user.email;

    if (!roomId) {
      return res.status(400).json({
        success: false,
        message: "Room ID is required"
      });
    }

    const docRef = db.collection("calls").doc(roomId);

    await db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(docRef);
      if (!snapshot.exists) return;

      const participants = snapshot.data().participants || [];
      const participantNames = snapshot.data().participantNames || [];

      // Remove user from participants
      participants.splice(participants.indexOf(userId), 1);
      participantNames.splice(participantNames.indexOf(userName), 1);

      if (participants.length === 0 || isHost) {
        // Delete room if empty or host leaves
        transaction.delete(docRef);
      } else {
        // Update room with remaining participants
        transaction.update(docRef, {
          participants: participants,
          participantNames: participantNames
        });
      }
    });

    res.status(200).json({
      success: true,
      message: "Left call room successfully"
    });

  } catch (error) {
    console.error("❌ Leave call room error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to leave call room"
    });
  }
});

// Get call room participants
app.get("/call-room-participants/:roomId", verifyToken, async (req, res) => {
  try {
    const { roomId } = req.params;
    const userEmail = req.user.email;

    const roomDoc = await db.collection("calls").doc(roomId).get();
    if (!roomDoc.exists) {
      return res.status(404).json({
        success: false,
        message: "Call room not found"
      });
    }

    const roomData = roomDoc.data();
    res.status(200).json({
      success: true,
      participants: roomData.participants || [],
      participantNames: roomData.participantNames || [],
      creator: roomData.creator,
      createdAt: roomData.createdAt
    });

  } catch (error) {
    console.error("❌ Get call participants error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get call participants"
    });
  }
});

// Get all active call rooms
app.get("/active-call-rooms", verifyToken, async (req, res) => {
  try {
    const snapshot = await db.collection("calls")
      .orderBy("createdAt", "desc")
      .get();

    const rooms = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate()
    }));

    res.status(200).json({
      success: true,
      rooms: rooms
    });

  } catch (error) {
    console.error("❌ Get active call rooms error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to get active call rooms"
    });
  }
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
// Middleware to verify JWT token on HTTP routes
function verifyToken(req, res, next) {
  const authHeader = req.header("Authorization");
  if (!authHeader) {
    return res.status(401).json({ success: false, message: "❌ No token provided" });
  }

  const token = authHeader.split(" ")[1];
  if (!token) {
    return res.status(401).json({ success: false, message: "❌ No token provided" });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded;
    next();
  } catch (err) {
    return res.status(401).json({ success: false, message: "❌ Invalid token" });
  }
}
// Add these to your Express server setup
app.use('/assets/audio', express.static('public/assets/audio', {
  setHeaders: (res, path) => {
    if (path.endsWith('.mp3') || path.endsWith('.wav') ||
        path.endsWith('.ogg') || path.endsWith('.m4a')) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }
}));

// Handle CORS for audio files
app.use((req, res, next) => {
  if (req.path.match(/\.(mp3|wav|ogg|m4a)$/)) {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, HEAD');
  }
  next();
});

app.post("/update-location", verifyToken, async (req, res) => {
  const { latitude, longitude } = req.body;
  if (!latitude || !longitude) {
    return res.status(400).json({ success: false, message: "Missing coordinates" });
  }

  try {
    const uid = req.user.uid || req.user.email; // match your JWT payload
    const username = req.user.username || req.user.email;

    const geoPoint = new admin.firestore.GeoPoint(latitude, longitude);

    // Compute geohash with a library for GeoFirePoint equivalent if needed
    // Here assume you store similar data to Flutter's GeoFirePoint structure

    await db.collection('users').doc(uid).set({
      uid,
      username,
      location: {
        geopoint: geoPoint,
        // Add geohash if you want geoqueries server side
      },
      locationEnabled: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp(),
    }, { merge: true });

    res.status(200).json({ success: true, message: "Location updated" });
  } catch (error) {
    console.error("❌ Location update error:", error);
    res.status(500).json({ success: false, message: "Failed to update location" });
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
      errorDetails: error.message
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

app.get("/nearby-users", verifyToken, async (req, res) => {
  const { latitude, longitude, radiusKm } = req.query;
  if (!latitude || !longitude || !radiusKm) {
    return res.status(400).json({ success: false, message: "Missing location or radius" });
  }

  // Implement geospatial query here using geohash or Firestore geo queries
  // For now, just a placeholder response.

  try {
    // Sample query: Fetch all users where locationEnabled == true
    const usersSnapshot = await db.collection('users')
      .where('locationEnabled', '==', true)
      .get();

    const users = usersSnapshot.docs.map(doc => doc.data());

    // You would normally filter on distance to latitude/longitude and radiusKm

    res.status(200).json({ success: true, users });
  } catch (error) {
    console.error('❌ Nearby users query error', error);
    res.status(500).json({ success: false, message: 'Failed to fetch nearby users' });
  }
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

    const allMembers = [...new Set([...members, creatorEmail])];
    const groupData = {
      name: groupName,
      members: allMembers,
      createdBy: creatorEmail,
      admin: creatorEmail,
      createdAt: FieldValue.serverTimestamp(),
      activeMembers: [creatorEmail],
      pinned: true
    };

    await db.collection('groups').doc(groupName).set(groupData);

    // Add to recent chats for all members
    const batch = db.batch();
    const recentData = {
      email: groupName,
      lastMessage: "Group created",
      timestamp: FieldValue.serverTimestamp(),
      seen: false,
      isGroup: true,
      members: allMembers,
      pinned: true,
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
      pinned: true,
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
      .delete();

    // Add system message
    await db.collection('groups')
      .doc(groupId)
      .collection('messages')
      .add({
        text: `${userEmail} removed ${memberEmail} from the group`,
        sender: 'System',
        timestamp: FieldValue.serverTimestamp(),
        isSystem: true
      });

    res.status(200).json({
      success: true,
      message: "Member removed successfully"
    });
  } catch (error) {
    console.error("❌ Remove group member error:", error);
    res.status(500).json({
      success: false,
      message: "Failed to remove member"
    });
  }
});

app.post("/updateProfileImage", verifyToken, async (req, res) => {
  const { imageUrl } = req.body;
  const userId = req.user.email;

  if (!imageUrl) {
    return res.status(400).json({ error: "Missing imageUrl" });
  }

  try {
    // Find user document by email
    const userSnapshot = await db.collection("users")
      .where("email", "==", userId)
      .get();

    if (userSnapshot.empty) {
      return res.status(404).json({ error: "User not found" });
    }

    const userDoc = userSnapshot.docs[0];
    await userDoc.ref.update({
      profilePic: imageUrl,
    });

    return res.status(200).json({ message: "Profile image updated" });
  } catch (error) {
    console.error("Error updating profile image:", error);
    return res.status(500).json({ error: "Failed to update image URL" });
  }
});

app.post("/toggle-pin-chat", verifyToken, async (req, res) => {
  try {
    const { chatId } = req.body;
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
// Add after your existing endpoints
// In your server.js upload-reel endpoint
app.post("/upload-reel", verifyToken, async (req, res) => {
  try {
    const {
      videoUrl,
      uploaderId,
      uploaderUsername,
      startTrim,
      endTrim,
      hapticMarkers,
      caption,
      createdAt, // This will be an ISO string from the client
      likeCount,
      commentCount,
      viewCount,
      duration
    } = req.body;

    // Convert ISO string back to Firestore timestamp
    const createdAtTimestamp = admin.firestore.Timestamp.fromDate(new Date(createdAt));

    const reelData = {
      videoUrl,
      uploaderId,
      uploaderUsername,
      startTrim,
      endTrim,
      hapticMarkers: hapticMarkers || [],
      caption: caption || '',
      createdAt: createdAtTimestamp, // Use the converted timestamp
      likeCount: likeCount || 0,
      commentCount: commentCount || 0,
      viewCount: viewCount || 0,
      duration: duration || 0,
    };

    await _firestore.collection('reels').add(reelData);

    res.status(201).json({
      success: true,
      message: "Reel uploaded successfully",
      reelId: ref.id
    });

  } catch (error) {
    console.error("❌ Reel upload error:", error);
    res.status(500).json({ success: false, message: "Failed to upload reel" });
  }
});
app.get("/reels", verifyToken, async (req, res) => {
  try {
    const { limit = 20, lastReelId } = req.query;
    const userEmail = req.user.email;

    let query = db.collection("reels")
      .orderBy("createdAt", "desc")
      .limit(parseInt(limit));

    // For pagination
    if (lastReelId) {
      const lastDoc = await db.collection("reels").doc(lastReelId).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();
    const reels = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate()
    }));

    res.status(200).json({
      success: true,
      reels,
      hasMore: reels.length === parseInt(limit)
    });

  } catch (error) {
    console.error("❌ Get reels error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch reels" });
  }
});
app.get("/user-reels/:userId", verifyToken, async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 20, lastReelId } = req.query;

    let query = db.collection("reels")
      .where("uploaderId", "==", userId)
      .orderBy("createdAt", "desc")
      .limit(parseInt(limit));

    if (lastReelId) {
      const lastDoc = await db.collection("reels").doc(lastReelId).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();
    const reels = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate()
    }));

    res.status(200).json({
      success: true,
      reels,
      hasMore: reels.length === parseInt(limit)
    });

  } catch (error) {
    console.error("❌ Get user reels error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch user reels" });
  }
});
// Like/Unlike reel
app.post("/reel/:reelId/like", verifyToken, async (req, res) => {
  try {
    const { reelId } = req.params;
    const userEmail = req.user.email;

    const reelRef = db.collection("reels").doc(reelId);
    const reelDoc = await reelRef.get();

    if (!reelDoc.exists) {
      return res.status(404).json({ success: false, message: "Reel not found" });
    }

    const likes = reelDoc.data().likes || [];
    const hasLiked = likes.includes(userEmail);

    if (hasLiked) {
      // Unlike
      await reelRef.update({
        likes: FieldValue.arrayRemove(userEmail),
        likeCount: FieldValue.increment(-1)
      });
    } else {
      // Like
      await reelRef.update({
        likes: FieldValue.arrayUnion(userEmail),
        likeCount: FieldValue.increment(1)
      });
    }

    res.status(200).json({
      success: true,
      liked: !hasLiked,
      likeCount: hasLiked ? reelDoc.data().likeCount - 1 : reelDoc.data().likeCount + 1
    });

  } catch (error) {
    console.error("❌ Like reel error:", error);
    res.status(500).json({ success: false, message: "Failed to like reel" });
  }
});

// Add comment to reel
app.post("/reel/:reelId/comment", verifyToken, async (req, res) => {
  try {
    const { reelId } = req.params;
    const { text } = req.body;
    const userEmail = req.user.email;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ success: false, message: "Comment text is required" });
    }

    const reelRef = db.collection("reels").doc(reelId);
    const reelDoc = await reelRef.get();

    if (!reelDoc.exists) {
      return res.status(404).json({ success: false, message: "Reel not found" });
    }

    // Get user info
    const userSnapshot = await db.collection("users")
      .where("email", "==", userEmail)
      .get();

    const userData = userSnapshot.docs[0].data();
    const username = userData.username || userEmail;
    const profilePic = userData.profilePic || "";

    // Add comment
    const commentData = {
      userId: userEmail,
      username,
      profilePic,
      text: text.trim(),
      createdAt: FieldValue.serverTimestamp()
    };

    const commentRef = await reelRef.collection("comments").add(commentData);

    // Update comment count
    await reelRef.update({
      commentCount: FieldValue.increment(1)
    });

    res.status(201).json({
      success: true,
      message: "Comment added",
      commentId: commentRef.id,
      comment: {
        ...commentData,
        id: commentRef.id,
        createdAt: new Date().toISOString()
      }
    });

  } catch (error) {
    console.error("❌ Add comment error:", error);
    res.status(500).json({ success: false, message: "Failed to add comment" });
  }
});

// Get reel comments
app.get("/reel/:reelId/comments", verifyToken, async (req, res) => {
  try {
    const { reelId } = req.params;
    const { limit = 20, lastCommentId } = req.query;

    let query = db.collection("reels").doc(reelId)
      .collection("comments")
      .orderBy("createdAt", "desc")
      .limit(parseInt(limit));

    if (lastCommentId) {
      const lastDoc = await db.collection("reels").doc(reelId)
        .collection("comments").doc(lastCommentId).get();
      if (lastDoc.exists) {
        query = query.startAfter(lastDoc);
      }
    }

    const snapshot = await query.get();
    const comments = snapshot.docs.map(doc => ({
      id: doc.id,
      ...doc.data(),
      createdAt: doc.data().createdAt?.toDate()
    }));

    res.status(200).json({
      success: true,
      comments,
      hasMore: comments.length === parseInt(limit)
    });

  } catch (error) {
    console.error("❌ Get comments error:", error);
    res.status(500).json({ success: false, message: "Failed to fetch comments" });
  }
});
const path = require("path");

// Update your multer configuration
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, "public/uploads/");
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + "-" + Math.round(Math.random() * 1e9);
    cb(null, file.fieldname + "-" + uniqueSuffix + path.extname(file.originalname));
  }
});

app.use('/uploads', express.static('public/uploads', {
  setHeaders: (res, path) => {
    if (path.endsWith('.mp4') || path.endsWith('.mov') ||
        path.endsWith('.avi') || path.endsWith('.webm')) {
      res.setHeader('Content-Type', 'video/mp4');
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
  }
}));
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

server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📱 WebSocket running on ws://localhost:${PORT}/ws`);
});
