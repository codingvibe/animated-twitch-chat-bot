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
const DEPLOYED = process.env.DEPLOYED;

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

app.use(cors(corsOptions));
let server;
if (DEPLOYED) {
  const privateKey = fs.readFileSync('/etc/letsencrypt/live/twitchbotapi.codingvibe.dev/privkey.pem');
  const certificate = fs.readFileSync('/etc/letsencrypt/live/twitchbotapi.codingvibe.dev/fullchain.pem');

  const credentials = {key: privateKey, cert: certificate};
  server = https.createServer(credentials, app);
  server.listen(APP_PORT)
} else {
  server = http.createServer(app)
  server.listen(APP_PORT)
}

/////////////////////////// Set up REST ///////////////////////////

app.get('/ticket', (req, res) => {
  const origin = req.get('origin');
  const ticket = generateTicket(origin);
  res.send({ticket:ticket})
})

/////////////////////////// Set up Websocket ///////////////////////////

const wss = new WebSocket.Server({server: server});

const currentConnections = [];
const activeTickets = {};
const TICKET_EXPIRATION = 60*1000;
const CHAT_COMMAND = "CHAT_COMMAND";
const POINTS_REDEMPTION = "POINTS_REDEMPTION";

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

function blastMessage(type, message) {
  currentConnections.forEach(ws => ws.send(JSON.stringify({'type': type, 'message': message})));
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
