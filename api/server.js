import axios from 'axios';
import * as tmi from 'tmi.js';
import { WebSocket } from 'ws';
import dotenv from 'dotenv';
import http from 'http';
import https from 'https';
import cors from 'cors';
import express from 'express';
import crypto from 'crypto';
import fs from 'fs';

dotenv.config();

const APP_PORT = 9090;
const CLIENT_ID = process.env.CLIENT_ID;
const CLIENT_SECRET = process.env.CLIENT_SECRET;
const ACCESS_TOKEN = process.env.ACCESS_TOKEN;
const REFRESH_TOKEN = process.env.REFRESH_TOKEN;
const EVENT_SUB_SECRET = process.env.EVENT_SUB_SECRET;
const DEPLOYED = process.env.DEPLOYED;
const PREFS_URL = process.env.PREFS_URL;
const PREFS_CACHE_TTL = process.env.PREFS_CACHE_TTL || 5*60*1000;

// Twitch Event Sub Notification request headers
const TWITCH_MESSAGE_ID = 'Twitch-Eventsub-Message-Id'.toLowerCase();
const TWITCH_MESSAGE_TIMESTAMP = 'Twitch-Eventsub-Message-Timestamp'.toLowerCase();
const TWITCH_MESSAGE_SIGNATURE = 'Twitch-Eventsub-Message-Signature'.toLowerCase();
const MESSAGE_TYPE = 'Twitch-Eventsub-Message-Type'.toLowerCase();

// Twitch Event Sub Notification message types
const MESSAGE_TYPE_VERIFICATION = 'webhook_callback_verification';
const MESSAGE_TYPE_NOTIFICATION = 'notification';
const MESSAGE_TYPE_REVOCATION = 'revocation';

// Twitch Event Sub Notification subscription types
const STREAM_ONLINE = "stream.online";

// user prefs cache
const userPrefs = {};

// Users Chatting cache
const chatters = new Set();

/////////////////////////// Set Up Server ///////////////////////////

const app = express();
const whitelist = ['https://twitchoverlay.codingvibe.dev']
if (!DEPLOYED) {
  whitelist.push('http://localhost:8000');
}

var corsOptions = {
  origin: function (origin, callback) {
    if (whitelist.indexOf(origin) !== -1) {
      callback(null, true)
    } else {
      callback(new Error('Not allowed by CORS'))
    }
  }
}


app.use([
  express.raw({ type: 'application/json'}), // Need raw message body for signature verification
  cors(corsOptions) // CORS because I'm coding this on stream and NOT doing CORS is cringe
]);

let server;
if (DEPLOYED) {
  const privateKey = fs.readFileSync('/etc/letsencrypt/live/twitchbotapi.codingvibe.dev/privkey.pem');
  const certificate = fs.readFileSync('/etc/letsencrypt/live/twitchbotapi.codingvibe.dev/fullchain.pem');

  const credentials = {key: privateKey, cert: certificate};
  server = https.createServer(credentials, app);
  server.listen(APP_PORT);
} else {
  server = http.createServer(app);
  server.listen(APP_PORT);
}

/*
TODO:
- test start-notifications
- get the speech bubble working
*/

/////////////////////////// Set up REST ///////////////////////////

app.get('/ticket', (req, res) => {
  const origin = req.get('origin');
  const ticket = generateTicket(origin);
  res.send({ticket:ticket});
})

app.post('/start-notifications', (req, res) => {
  processNotificationsQueue();
  res.sendStatus(204);
})

app.post('/eventsub', (req, res) => {
  let hmac = HMAC_PREFIX + getHmac(EVENT_SUB_SECRET, req);

  if (true === verifyMessage(hmac, req.headers[TWITCH_MESSAGE_SIGNATURE])) {
    let notification = JSON.parse(req.body);

    if (MESSAGE_TYPE_NOTIFICATION === req.headers[MESSAGE_TYPE]) {
      if (notification && notification.subscription) {
        switch (notification.subscription.type) {
          case STREAM_ONLINE:
            chatters.clear();
            notificationQueue.clear();
            queuePaused = true;
            setTimeout(() => {
              processNotificationsQueue();
            }, 5*60*1000); // TODO, SET THIS TO SOMETHING LARGER
            break;
          default:
            //do nothing;
        }
      }
      res.sendStatus(204);
    }
    else if (MESSAGE_TYPE_VERIFICATION === req.headers[MESSAGE_TYPE]) {
      res.status(200).send(notification.challenge);
    }
    else if (MESSAGE_TYPE_REVOCATION === req.headers[MESSAGE_TYPE]) {
      res.sendStatus(204);

      console.log(`${notification.subscription.type} notifications revoked!`);
      console.log(`reason: ${notification.subscription.status}`);
      console.log(`condition: ${JSON.stringify(notification.subscription.condition, null, 4)}`);
    }
    else {
      res.sendStatus(204);
      console.log(`Unknown message type: ${req.headers[MESSAGE_TYPE]}`);
    }
  }
  else {
      console.log('403');    // Signatures didn't match.
      res.sendStatus(403);
  }
})

/////////////////////////// Set up Websocket ///////////////////////////

const wss = new WebSocket.Server({server: server});

const currentConnections = [];
const activeTickets = {};
const TICKET_EXPIRATION = 60*1000;
const CHAT_COMMAND = "CHAT_COMMAND";
const POINTS_REDEMPTION = "POINTS_REDEMPTION";
const STREAM_START = "STREAM_START";
const FIRST_CHAT = "FIRST_CHAT";

setupTmiClient();
openTwitchWebsocket();

wss.on('connection', (ws, request) => {
  const origin = getOriginFromHeaders(request.rawHeaders);
  if (whitelist.indexOf(origin) == -1) {
    console.log(`whitelist does not contain origin ${origin}`);
    ws.close();
    return;
  }
  if (!validateTicket(request.url, origin)) {
    console.log(`invalid ticket ${request.url} ${origin}`);
    console.log(activeTickets);
    ws.close();
    return;
  }
  currentConnections.push(ws);
});

/////////////////////////// Web Socket Validation ///////////////////////////

function getOriginFromHeaders(headers) {
  for (let i = 0; i < headers.length; i++) {
    if (headers[i] === "Origin") {
      return headers[i+1];
    }
  }
  return null;
}

function validateTicket(url, origin) {
  const index = url.indexOf('ticket=');
  const submittedTicket = url.substring(index + 7);
  let foundTicket;
  for (let ticket in activeTickets) {
    if (ticket === submittedTicket &&
        activeTickets[ticket].origin === origin &&
        activeTickets[ticket].expiration > Date.now()) {
        foundTicket = ticket;
      break;
    }
  }
  if (foundTicket) {
    delete activeTickets[foundTicket]
    return true;
  }
  return false;
}

function generateTicket(origin) {
  const ticket = crypto.randomBytes(20).toString('hex');
  activeTickets[ticket] = {
    origin: origin,
    expiration: Date.now() + TICKET_EXPIRATION
  };
  return ticket;
}

const ticketCleanup = setInterval(() => {
  const expiredTickets = []
  Object.keys(activeTickets).forEach(ticket => {
    if (activeTickets[ticket].expiration < Date.now()) {
      expiredTickets.push(ticket);
    }
  })
  expiredTickets.forEach(ticket => delete activeTickets[ticket])
}, 1000);

/////////////////////////// Listen to Twitch Chat ///////////////////////////

function setupTmiClient() { // Setup TMI to listen to Twitch Chat
  const client = new tmi.Client({ // Setup TMI Client with the channel(s) you want to listen to
    channels: ["codingvibe"],
  });

  client.connect(); // Connect to the channel

  client.on("message", (channel, tags, message, self) => { // Run each time a comment comes in
    let name = tags["display-name"]; // Commenter's Name

    if (!chatters.has(name)) {
      blastMessage(FIRST_CHAT, {'username': name});
      chatters.add(name);
    }

    if (message && message.includes("!lurk")) {
      blastMessage(CHAT_COMMAND, {'username': name, 'command': 'lurk'});
    }
  });
}

/////////////////////////// Process pub/sub messages ///////////////////////////

const messageTypeToProcessor = {
  "channel-points-channel-v1": processChannelPoints
};

function processChannelPoints(data) {
  const redemptionType = data.data.redemption.reward.title;
  const name = data.data.redemption.user.display_name;
  console.log(`got this reward ${redemptionType}`)
  blastMessage(POINTS_REDEMPTION, {'username': name, 'command': redemptionType});
}

/////////////////////////// Web Socket Communication ///////////////////////////
let queuePaused = false;
const notificationQueue = [];

async function blastMessage(type, message) {
  const prefs = await getPreferences(message.username);
  message["prefs"] = prefs;
  const event = {'type': type, 'message': message};
  if (queuePaused) {
    notificationQueue.push(event)
  } else {
    currentConnections.forEach(ws => ws.send(JSON.stringify(event)));
  }
}

function processNotificationsQueue() {
  queuePaused = false;
  const processQueue = setInterval(() =>{
    if (notificationQueue.length > 0) {
      message = notificationQueue.pop();
      blastMessage(notificationQueue.type, notificationQueue.message)
    } else {
      clearInterval(processQueue);
    }
  }, 500);
}

/////////////////////////// Get user preferences //////////////////////////////
async function getPreferences(username) {
  if (!(username in userPrefs) || userPrefs[username].expiration < Date.now()) {
    const prefs = await getPreferencesFromService(username);
    if (prefs || !(username in userPrefs)) {
      userPrefs[username] = {
        "expiration": Date.now() + PREFS_CACHE_TTL,
        "prefs": prefs
      }
    }
  }
  return userPrefs[username].prefs;
}

async function getPreferencesFromService(username) {
  try {
    const response = await axios.get(`${PREFS_URL}/prefs?twitchId=${username}`);
    if (response.status > 299) {
      console.error(`Error retrieving prefs. ${response.data}`)
      return null;
    }
    return response.data.prefs;
  } catch (e) {
    console.log(`No preferences found for ${username}`);
    return null;
  }
}

/////////////////////////// Talk to Twitch API ///////////////////////////

async function getTwitchAuthToken(clientId, clientSecret, accessToken, refreshToken) {
  const authUrl = `https://id.twitch.tv/oauth2/token?client_id=${clientId}&client_secret=${clientSecret}&grant_type=refresh_token&refresh_token=${refreshToken}`
  const response = await axios.post(authUrl);
  if (response.status > 299) {
    console.error(`Ding dangit, had a dang ol issue with Twitch. ${response.data}`)
  }
  return response.data.access_token;
}

async function openTwitchWebsocket() {
  const token = await getTwitchAuthToken(CLIENT_ID, CLIENT_SECRET, ACCESS_TOKEN, REFRESH_TOKEN);
  const twitchSocket = new WebSocket("wss://pubsub-edge.twitch.tv");

  let interval;
  twitchSocket.onopen = (data) => {
    console.log(`opening connection to Twitch with token ${token}`);
    twitchSocket.send(JSON.stringify({
      "type": "LISTEN",
      "data": {
        "topics": ["channel-points-channel-v1.754502464"],
        "auth_token": token
      }
    }));

    interval = setInterval(() => {
      twitchSocket.send('{"type": "PING"}');
    }, 3000);
  }

  twitchSocket.onclose = () => {
    console.log("Connection closed! Attempting to reopen...");
    if (interval) {
      clearInterval(interval);
    }
    openTwitchWebsocket();
  }

  twitchSocket.onmessage = (event) => {
    const eventData = JSON.parse(event.data);
    if (eventData.type == "PONG") {
      //console.log ("pong boiz");
    } else if (eventData.type == "MESSAGE") {
      const topic = eventData.data.topic.split("\.")[0];
      if (!(topic in messageTypeToProcessor)) {
        console.log(`unhandled message topic ${topic}`);
        return;
      }
      const processor = messageTypeToProcessor[topic]
      processor(JSON.parse(eventData.data.message));
    }
  }
}

/////////////////////////// Twitch Event Sub Verification ///////////////////////////

// Get the HMAC.
function getHmac(secret, request) {
  const message = (request.headers[TWITCH_MESSAGE_ID] + 
    request.headers[TWITCH_MESSAGE_TIMESTAMP] + 
    request.body)
  return crypto.createHmac('sha256', secret)
  .update(message)
  .digest('hex');
}

// Verify whether your signature matches Twitch's signature.
function verifyMessage(hmac, verifySignature) {
  return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(verifySignature));
}