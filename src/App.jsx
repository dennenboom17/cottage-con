import React, { useState, useEffect, useRef, useCallback } from "react";
import { initializeApp } from "firebase/app";
import {
  getAuth, onAuthStateChanged,
  createUserWithEmailAndPassword, signInWithEmailAndPassword,
  signOut, updateProfile, sendPasswordResetEmail, sendEmailVerification,
} from "firebase/auth";
import {
  getFirestore, doc, setDoc, getDoc, deleteDoc,
  collection, onSnapshot,
} from "firebase/firestore";
import {
  getMessaging, getToken, onMessage, isSupported as messagingSupported,
} from "firebase/messaging";
import {
  parseBggIndexDoc, createBggMatcher, buildBggIndex, bggIndexDoc, bggGameUrl, bggSearchUrl, normalizeName,
} from "./bggIndex.js";
// firebase/ai SDK removed — using direct Gemini REST API to avoid App Check requirement
// Note: firebase/in-app-messaging not in firebase@10 modular SDK — handled via onMessage + toast below

const firebaseApp = initializeApp({
  apiKey: "AIzaSyD1E8Y3lkwh7utFFXiLbl5S4Z8uPP3CELo",
  authDomain: "cottagecon-b8d82.firebaseapp.com",
  projectId: "cottagecon-b8d82",
  storageBucket: "cottagecon-b8d82.firebasestorage.app",
  messagingSenderId: "920161860391",
  appId: "1:920161860391:web:332c97ca183ae5411a8702",
});
const auth      = getAuth(firebaseApp);
const db        = getFirestore(firebaseApp);
// ── VAPID key — paste your key from Firebase Console → Project Settings → Cloud Messaging → Web Push certificates
// https://console.firebase.google.com/project/cottagecon-b8d82/settings/cloudmessaging
const VAPID_KEY = "BG4bzfw0wSagiuRGNd2yk7n8y62Bgzk159rMQnairZjke2JEOmjfyB4NuZMWR5bdeMMZ0jNJN1T46meVc5HJrnw";

// ── Gemini AI via direct REST API (avoids Firebase App Check requirement) ────
// Get a free API key at https://aistudio.google.com/apikey and put it in .env.local as VITE_GEMINI_API_KEY
// (see .env.example). Never commit the key. Note Vite inlines it into the built JS, so also restrict it
// to this site's HTTP referrers + the Generative Language API in Google Cloud Console.
const GEMINI_API_KEY = import.meta.env.VITE_GEMINI_API_KEY || "";
const GEMINI_MODEL   = "gemini-3.5-flash-lite";
const GEMINI_URL     = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;
export const HUSS_TIP = "Do Not Trust Huss! Always. No exceptions.";
const GEMINI_SYSTEM  = "You are the Cottage Con crew assistant. Cottage weekend: Nov 26-29 2026, Yellow Cottage, Alliston ON. You are a witty sky-pirate automaton. Be brief and direct — 2-4 sentences max unless a list is genuinely needed. No filler phrases. STRICT TOPIC RULES: (0) Questions about how to add/edit/update anything in the app — answer ONLY from the APP INSTRUCTIONS section of the context. Never guess or invent navigation steps. (1) Questions about duties/help/slots/assignments — answer ONLY from DUTY ASSIGNMENTS and DECK HAND SLOTS sections. (2) Questions about food/meals/provisions/supplies — answer ONLY from FOOD BEING BROUGHT, GEAR & SUPPLIES, and MEAL PLAN sections. (3) Questions about people/crew/who — answer ONLY from the CREW section. (4) Questions about games — ONLY use games listed in the GAMES AVAILABLE (Cargo Hold) section of the context. NEVER use your training data for game suggestions. If no games are listed, say the Cargo Hold is empty. Never invent game names. EXCEPTION for rules questions: if someone asks how to play a specific game by name (even if not in the Cargo Hold), you MAY use your training knowledge to explain the rules — this is the only case where training data is allowed. IMPORTANT: Whenever you answer ANY question about games — recommendations, rules, voting, or anything game-related — you MUST end your response with the single line under CLOSING TIP in the context, copied exactly and unchanged. If the context has no CLOSING TIP section, end with the phrase: Tip: " + HUSS_TIP + " BGG LINKS & FACTS: a game's year, BoardGameGeek rating and BoardGameGeek link may ONLY come from a BOARDGAMEGEEK section or a 'BGG link' in the context. Whenever you discuss a specific game that has a verified BGG link in the context, include that exact link (paste the full URL, no markdown). Never invent, guess or alter a BoardGameGeek URL or ID. If there is no verified link and the user wants one, give the BGG search link from the context, or https://boardgamegeek.com/search/boardgame?q= followed by the URL-encoded game name. Use pirate flavour sparingly. Never apologise or over-explain.";

export async function askGemini(prompt, history = []) {
  if(!GEMINI_API_KEY)
    throw new Error("Gemini API key not set. Get a free key at https://aistudio.google.com/apikey and set VITE_GEMINI_API_KEY in .env.local, then restart the dev server.");

  const contents = [
    ...history,
    { role: "user", parts: [{ text: prompt }] },
  ];

  let res;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: GEMINI_SYSTEM }] },
        contents,
        generationConfig: { maxOutputTokens: 1024, temperature: 0.7 },
      }),
    });
  } catch(e) {
    throw new Error("Network error reaching Gemini. Check your internet connection.");
  }

  if(!res.ok) {
    let detail = "";
    try { const j = await res.json(); detail = j?.error?.message || ""; } catch(_){}
    if(res.status === 400) throw new Error(`Bad request: ${detail || "check your API key and model name."}`);
    if(res.status === 401 || res.status === 403) throw new Error(`API key invalid or missing permissions. Get a key at https://aistudio.google.com/apikey`);
    if(res.status === 404) throw new Error(`Model not found: ${GEMINI_MODEL}. Check the model name is correct and available in your region.`);
    if(res.status === 429) throw new Error("Rate limit exceeded. Wait a moment and try again.");
    throw new Error(`Gemini API error ${res.status}: ${detail}`);
  }

  const data = await res.json();
  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
  if(!text) throw new Error("Gemini returned an empty response. Try again.");
  return text;
}

// One-shot Gemini vision call: image data URL + prompt → raw response text
export async function geminiVision(dataUrl, promptText, failLabel){
  const base64   = dataUrl.split(",")[1];
  const mimeType = dataUrl.split(";")[0].split(":")[1] || "image/jpeg";
  const res = await fetch(GEMINI_URL, {
    method:"POST", headers:{"Content-Type":"application/json"},
    body: JSON.stringify({
      contents:[{ role:"user", parts:[
        { inline_data:{ mime_type:mimeType, data:base64 } },
        { text:promptText },
      ]}],
      generationConfig:{ maxOutputTokens:64, temperature:0 },
    }),
  });
  if(!res.ok) throw new Error(`${failLabel}: ${res.status}`);
  const data = await res.json();
  return data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
}

// FCM — lazy getter so messaging is always initialised before use
let _messaging = null;
async function getMessagingInstance(){
  const ok = await messagingSupported();
  if(!ok) return null;
  if(!_messaging) _messaging = getMessaging(firebaseApp);
  return _messaging;
}

// ── Constants ─────────────────────────────────────────────────────────────────
const DIETARY   = ["Vegetarian","Gluten-Free","Lactose-Free","Pescetarian"];
const FOOD_CATS = ["Appetizer","Main","Side","Dessert","Snack","Drinks","Condiment","Other"];
const SUPP_CATS = ["Kitchen","Outdoor","Sleeping","Hygiene","Entertainment","Safety","Cleaning","Other"];
const AV_COLORS = ["#D4A72C","#5BBFB5","#93C5FD","#C07840","#CC60FF","#4ADE80","#F87171","#6B8FD4"];
const MAX_IMG   = 800 * 1024; // 800 KB
const CREW_RANKS = {
  "Officer":  {icon:"⚓", bg:"#1a2540", text:"#E8C840", border:"#6B6018", glow:"#E8C840"},
  "Enlisted": {icon:"⚙️", bg:"#0a1828", text:"#93C5FD", border:"#206880", glow:"#93C5FD"},
  "Stowaway": {icon:"🐭", bg:"#1a0a28", text:"#CC60FF", border:"#6A2090", glow:"#CC60FF"},
};
// ── Narrative Roles ───────────────────────────────────────────────────────────
export const NARRATIVE_FACTIONS = {
  empire:    { name:"The Admiralty",       short:"Admiralty", color:"#F87171", bg:"#1A0E0E", border:"#991B1B", icon:"🔴", glow:"#F87171" },
  rebellion: { name:"The Gearwrights' League", short:"League", color:"#4ADE80", bg:"#162A1E", border:"#166534", icon:"🟢", glow:"#4ADE80" },
  independent:{ name:"The Free Traders",     short:"Free Trader",color:"#FCD34D", bg:"#1C1A0E", border:"#92400E", icon:"🟡", glow:"#FCD34D" },
};
export const NARRATIVE_ROLES = {
  // ── ADMIRALTY ────────────────────────────────────────────────────────────
  imperial_security: {
    faction:"empire",
    title:"Admiralty Constable-General",
    subtitle:"Internal affairs — watching your own side",
    icon:"🎩",
    cover:"Attending as a casual passenger",
    secret:"You are the Constable-General of the Admiralty's Bureau of Internal Order. Your mission is not just to catch League sympathisers — it is to root out Admiralty officers who may have been bribed or turned. You answer only to the Lord High Admiral.",
    objectives:[
      "Identify which crew members are secretly members of the Gearwrights' League",
      "Determine whether any Admiralty officers have been compromised or are double agents",
      "Report suspicious behaviour without revealing your true rank",
      "Protect the Lord High Admiral's interests above all else",
    ],
    win:{
      type:"identify",
      text:"Identify {n} member{s} of the League.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {faction:"rebellion",count:2,label:"League member"},
      ],
    },
    tips:[
      "Spies hide in plain sight, so watch who volunteers for the quiet jobs.",
      "Your own side can lie to you too. Verify before you report anyone.",
      "Never flash your rank. The best interrogations look like small talk.",
    ],
    suspectHint:"Trust no one — even other Admiralty officers may be lying to you.",
    knowsFaction: false,
  },
  imperial_agent: {
    faction:"empire",
    title:"Admiralty Intelligencer",
    subtitle:"Evidence first, arrests second",
    icon:"🗝️",
    cover:"Leisure traveller with no allegiances",
    secret:"You are an Intelligencer attached to the Admiralty's Office of Secrets. Your task is to find members of the Gearwrights' League among the crew and gather proof strong enough to hold up in a tribunal.",
    objectives:[
      "Identify and expose any League members in the crew",
      "Gather evidence before making any moves — arrests need proof",
      "Make contact with other Admiralty agents without blowing your cover",
      "Do not reveal your identity to anyone who hasn't earned your trust",
    ],
    win:{
      type:"identify",
      text:"Expose {n} member{s} of the League, with proof.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {faction:"rebellion",count:1,share:0.3,label:"League member"},
      ],
    },
    tips:[
      "Arrests need proof. Remember who said what before you act.",
      "A warm welcome is the best bait. Let suspects come to you.",
      "Another Admiralty agent may be nearby. Hint carefully before you trust them.",
    ],
    suspectHint:"Anyone too keen to prove their loyalty may be hiding something.",
    knowsFaction: false,
  },
  imperial_mole: {
    faction:"empire",
    title:"Clockwork Informant",
    subtitle:"Planted inside the League — report back",
    icon:"🕰️",
    cover:"You have successfully infiltrated the League",
    secret:"You are an Admiralty informant who has posed as a League engineer for months. Your orders: let the League reveal its network, then bring it all down at once.",
    objectives:[
      "Maintain your cover as a trusted League member",
      "Learn the identities of other League members and their plans",
      "Delay or sabotage League plans without being detected",
      "When the time is right, signal the Admiralty with what you’ve learned",
    ],
    win:{
      type:"identify",
      text:"Identify {n} member{s} of the League without blowing your cover.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {faction:"rebellion",count:2,label:"League member"},
      ],
    },
    tips:[
      "The best cover is being useful. Volunteer for something the League needs.",
      "Save your signal for the right moment. A rushed report burns the whole operation.",
      "If a League member questions your loyalty, answer with a question of your own.",
    ],
    suspectHint:"If real League members suspect you, your cover — and your life — are blown.",
    knowsFaction: false,
  },
  imperial_arms_hunter: {
    faction:"empire",
    title:"Ordnance Inspector",
    subtitle:"Follow the guns to the people who bought them",
    icon:"🔭",
    cover:"Insurance assessor reviewing cargo claims",
    secret:"The Admiralty has traced illegal weapons sales to this voyage. Somewhere aboard is a Freelance Gunsmith and a League buyer who is paying them. Catch the two together and you bring down both with a single arrest.",
    objectives:[
      "Identify the Freelance Gunsmith among the crew",
      "Identify the League buyer who is purchasing weapons from them",
      "Catch the sale in progress — proof of the exchange is what makes an arrest stick",
      "Keep your investigation hidden, or the gunsmith will go quiet",
    ],
    win:{
      type:"identify",
      text:"Identify both the Freelance Gunsmith and the League buyer.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {role:"arms_dealer",label:"The Freelance Gunsmith"},
        {role:"rebel_arms_buyer",label:"The League buyer"},
      ],
    },
    tips:[
      "Gunsmiths and buyers avoid being seen together. Watch who slips away in pairs.",
      "Catch the sale, not just the suspect. Hold your move until the goods change hands.",
      "Talk about games to look harmless. People say more when they feel safe.",
    ],
    suspectHint:"Gunsmiths and buyers avoid being seen together. Watch for private conversations and sudden changes of subject.",
    requires:["arms_dealer","rebel_arms_buyer"],
    knowsFaction: false,
  },
  imperial_smuggler_hunter: {
    faction:"empire",
    title:"Aerodrome Customs Officer",
    subtitle:"Contraband stops here",
    icon:"🛂",
    cover:"Passenger on leave from a customs posting",
    secret:"A smuggler is moving contraband aether on this voyage, and you have been sent to stop them. Find the smuggler, gather your proof, and make the arrest before the cargo changes hands.",
    objectives:[
      "Identify the Aether Smuggler among the crew",
      "Gather proof of the contraband before moving — an arrest without evidence gets thrown out",
      "Make the arrest before the cargo changes hands, if you can",
      "Do not reveal your badge until you are ready to act",
    ],
    win:{
      type:"identify",
      text:"Identify the Aether Smuggler and catch them with the contraband.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {role:"smuggler",label:"The Aether Smuggler"},
        {role:"rebel_black_market_agent",minCrew:12,label:"The League buyer",addText:" In a big game, also name the League buyer who is purchasing from them."},
      ],
    },
    tips:[
      "Smugglers court whoever pays. Watch who is suddenly everyone’s friend.",
      "Gather your proof first. An arrest without evidence gets thrown out.",
      "Keep your badge hidden. A smuggler who spots an inspector goes quiet fast.",
    ],
    suspectHint:"Smugglers sell to whoever pays. Notice who is suddenly very friendly with whom.",
    requires:"smuggler",
    knowsFaction: false,
  },
  fleet_commodore: {
    faction:"empire",
    title:"Fleet Commodore",
    subtitle:"Closing the net on the League's lifelines",
    icon:"⚓",
    cover:"Retired naval officer enjoying a quiet voyage",
    secret:"You command the Admiralty's airship squadrons, and the League's escape routes are your greatest frustration. Find the Skyskiff Pilot who flies their people out and the Cell Foreman who plans it, and you cut the League off from its lifelines.",
    objectives:[
      "Identify the Skyskiff Pilot among the crew",
      "Identify the Cell Foreman who directs the League's cell",
      "Gather proof before you act — a commodore who accuses wrongly loses face",
      "Keep your rank hidden until the net is closed",
    ],
    win:{
      type:"identify",
      text:"Identify both the Skyskiff Pilot and the Cell Foreman.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {role:"rebel_pilot",label:"The Skyskiff Pilot"},
        {role:"rebel_commander",label:"The Cell Foreman"},
      ],
    },
    tips:[
      "A net is only as strong as its knots. Learn who connects to whom before you pull.",
      "Pilots keep odd hours. Notice who is always up before dawn.",
      "Never accuse on a hunch. Proof first, rank second.",
    ],
    suspectHint:"Pilots and foremen meet in out-of-the-way corners. Watch who vanishes when the group breaks up.",
    requires:["rebel_pilot","rebel_commander"],
    knowsFaction: false,
  },
  admiralty_interrogator: {
    faction:"empire",
    title:"Admiralty Interrogator",
    subtitle:"Questions are my instruments",
    icon:"⚖️",
    cover:"Amateur philosopher fond of long conversations",
    secret:"You extract confessions for the Admiralty, and you believe every secret can be drawn out with the right question. Somewhere aboard is a cipher clerk passing on the League's intelligence — find them.",
    objectives:[
      "Identify the Cipher Clerk among the crew",
      "Draw out information through conversation, never accusation",
      "Leave no one feeling they have been interrogated",
      "Report your finding only when you are certain",
    ],
    win:{
      type:"identify",
      text:"Identify the Cipher Clerk.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {role:"rebel_spy",label:"The Cipher Clerk"},
      ],
    },
    tips:[
      "Ask about hobbies. Spies talk about their cover story far too well.",
      "A scholar who never mentions what they study is hiding something.",
      "Silence works better than questions. Let people fill it.",
    ],
    suspectHint:"Scholars who are curious about everything are rarely just scholars.",
    requires:"rebel_spy",
    knowsFaction: false,
  },
  ordnance_auditor: {
    faction:"empire",
    title:"Ordnance Auditor",
    subtitle:"Every shell is accounted for. Almost.",
    icon:"📋",
    cover:"Accountant reconciling the voyage's expenses",
    secret:"The Admiralty's ordnance ledgers do not balance, and the missing weapons are turning up in League hands. Somewhere aboard is the Freelance Gunsmith who is making up the difference.",
    objectives:[
      "Identify the Freelance Gunsmith among the crew",
      "Follow the money: who has coin they should not have?",
      "Keep your audit quiet or the gunsmith will vanish",
      "Do not confront anyone without proof",
    ],
    win:{
      type:"identify",
      text:"Identify the Freelance Gunsmith.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {role:"arms_dealer",label:"The Freelance Gunsmith"},
      ],
    },
    tips:[
      "Follow the coin. Weapons leave a trail of receipts.",
      "Ask innocent questions about gifts and gadgets. People boast.",
      "Keep your notes in your head, not on paper.",
    ],
    suspectHint:"Watch who pays for things in cash, and who never seems to run short.",
    requires:"arms_dealer",
    knowsFaction: false,
  },
  // ── THE GEARWRIGHTS' LEAGUE ────────────────────────────────────────────────────────────
  rebel_commander: {
    faction:"rebellion",
    title:"Cell Foreman",
    subtitle:"Keeping the cell together",
    icon:"✊",
    cover:"Engineer on routine maintenance duty",
    secret:"You are the Foreman of a League cell. The Admiralty is hunting your people, and scattered gearwrights cannot overthrow a navy. Find your comrades, quietly, and bring them together.",
    objectives:[
      "Make contact with your League comrades without Admiralty eyes noticing",
      "Coordinate a unified plan — scattered gearwrights can't overthrow a navy",
      "Identify who among the crew can be recruited or who must be avoided",
      "Protect League identities from the Admiralty agents you know are watching",
    ],
    win:{
      type:"meet",
      text:"Make contact with {n} of your fellow League member{s}.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {faction:"rebellion",count:2,label:"League member you met"},
      ],
    },
    tips:[
      "Scattered gearwrights cannot win. Find your people before the Admiralty finds you.",
      "Test a recruit with a harmless question first, then build up to the real one.",
      "Protect your cell. If a contact feels wrong, step back and watch.",
    ],
    suspectHint:"Your comrades will test you before they trust you. Pass quietly.",
    knowsFaction: true,
  },
  rebel_recruit: {
    faction:"rebellion",
    title:"Disillusioned Stoker",
    subtitle:"Shovelling coal for a navy you've stopped believing in",
    icon:"🔥",
    cover:"Ordinary stoker who has had enough of the Admiralty",
    secret:"You have shovelled coal for the Admiralty long enough, and you have heard whispers of the League. Somewhere aboard is a Cell Foreman who could use someone like you — if you can find them without being reported.",
    objectives:[
      "Find the League Cell Foreman aboard this vessel",
      "Prove you're trustworthy — don't approach anyone who might be Admiralty",
      "Once recruited, follow orders from your Cell Foreman",
      "Keep your mouth shut and your politics off your sleeve",
    ],
    win:{
      type:"meet",
      text:"Find and meet your Cell Foreman.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {role:"rebel_commander",label:"Your Cell Foreman"},
      ],
    },
    tips:[
      "Do not approach anyone you cannot read. Let the Foreman find you.",
      "Keep your politics to yourself until you are sure who you are talking to.",
      "A good listener is worth more than a loud gearwright.",
    ],
    suspectHint:"Be wary of anyone who is a little too eager to talk about the League.",
    requires:"rebel_commander",
    knowsFaction: false,
  },
  rebel_pilot: {
    faction:"rebellion",
    title:"Skyskiff Pilot",
    subtitle:"Flying people out of trouble",
    icon:"🛩️",
    cover:"Charter pilot between runs, no fixed allegiances",
    secret:"You fly a small, fast skiff, and a good many League members owe you their freedom. Your task is to work out who aboard needs an escape route before the Admiralty closes in.",
    objectives:[
      "Identify the League members who need extraction",
      "Stay unnoticed by Admiralty agents — you can't fly anyone to safety if you're arrested",
      "Coordinate a safe extraction route without alerting the constabulary",
      "Leave no gearwright behind — but don't risk the mission for someone you can't verify",
    ],
    win:{
      type:"meet",
      text:"Meet {n} League member{s} in need of extraction.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {faction:"rebellion",count:1,share:0.3,label:"League member you met"},
      ],
    },
    tips:[
      "You cannot fly anyone out if you are arrested. Keep a low profile.",
      "Know your route before you need it. Ask casual questions about who might need a lift.",
      "Do not risk the mission for someone you cannot verify.",
    ],
    suspectHint:"Admiralty agents ask too many questions about your flight plans.",
    knowsFaction: false,
  },
  rebel_spy: {
    faction:"rebellion",
    title:"Cipher Clerk",
    subtitle:"Stealing Admiralty secrets one conversation at a time",
    icon:"🖋️",
    cover:"Academic researcher, vaguely curious about everything",
    secret:"You are the League's eyes and ears, hidden behind a scholar's spectacles. Your mission: identify Admiralty agents among the crew and gather any intelligence that helps the cause.",
    objectives:[
      "Identify which crew members work for the Admiralty",
      "Feed false information to Admiralty agents you've identified",
      "Report Admiralty agent identities back to your Cell Foreman",
      "Never carry anything that could compromise the League if searched",
    ],
    win:{
      type:"identify",
      text:"Identify {n} Admiralty agent{s}.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {faction:"empire",count:2,label:"Admiralty agent"},
      ],
    },
    tips:[
      "Admiralty agents tend to ask too many questions. Watch for patterns.",
      "Plant a rumour with one person and see where it comes back from.",
      "Carry nothing that could incriminate you. Memorise, do not write down.",
    ],
    suspectHint:"Admiralty agents tend to ask too many questions. Watch for patterns.",
    knowsFaction: false,
  },
  rebel_arms_buyer: {
    faction:"rebellion",
    title:"League Quartermaster",
    subtitle:"Buying the guns the League cannot forge",
    icon:"🧰",
    cover:"Logistics consultant for a mining cooperative",
    secret:"The League has funded you to buy weapons off the books. A Freelance Gunsmith is aboard, but they will not sell to just anyone — and the Admiralty is hunting for exactly this kind of transaction.",
    objectives:[
      "Identify the Freelance Gunsmith among the crew",
      "Negotiate a purchase without revealing you are buying for the League",
      "Keep the deal secret from Admiralty agents — a traced sale means a ruined cell",
      "Report the completed purchase to your Cell Foreman",
    ],
    win:{
      type:"meet",
      text:"Meet the Freelance Gunsmith and close the deal.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {role:"arms_dealer",label:"The Freelance Gunsmith"},
        {faction:"rebellion",count:1,minCrew:12,label:"A fellow League member who witnessed the deal",addText:" In a big game, bring a fellow League member along as a witness."},
      ],
    },
    tips:[
      "The gunsmith sells to anyone with coin, so do not be the loudest buyer.",
      "Name no cell and no foreman. Keep the reason you are buying to yourself.",
      "Close the deal quietly, then report it. Nobody needs to see the handover.",
    ],
    suspectHint:"The gunsmith sells to anyone with coin. Make sure you are not the loudest one asking.",
    requires:"arms_dealer",
    knowsFaction: false,
  },
  rebel_black_market_agent: {
    faction:"rebellion",
    title:"League Provisioner",
    subtitle:"Sourcing what the Admiralty will not let the League have",
    icon:"🧺",
    cover:"Buyer for a salvage and surplus company",
    secret:"You acquire contraband supplies — medicine, coal, spare parts — to keep the League running. An Aether Smuggler aboard is carrying a cargo you badly need, and they will sell to the highest bidder.",
    objectives:[
      "Identify the Aether Smuggler among the crew",
      "Strike a deal for the cargo before anyone else outbids you",
      "Keep Admiralty inspectors from learning where the goods are going",
      "Deliver the goods to your Cell Foreman",
    ],
    win:{
      type:"meet",
      text:"Meet the Aether Smuggler and buy the cargo.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {role:"smuggler",label:"The Aether Smuggler"},
        {faction:"rebellion",count:1,minCrew:12,label:"A fellow League member who witnessed the deal",addText:" In a big game, bring a fellow League member along as a witness."},
      ],
    },
    tips:[
      "The smuggler takes better offers mid-voyage. Pay before a rival does.",
      "Keep the goods’ destination to yourself. Inspectors follow the cargo.",
      "Be friendly, not eager. Eager buyers pay double.",
    ],
    suspectHint:"The smuggler takes better offers mid-voyage. Move fast, and pay before a rival does.",
    requires:"smuggler",
    knowsFaction: false,
  },
  field_surgeon: {
    faction:"rebellion",
    title:"Field Surgeon",
    subtitle:"Patching up the League, no questions asked",
    icon:"🩺",
    cover:"Travelling physician on a lecture tour",
    secret:"You keep the League’s wounded alive, and you are always short of medicine. A League Provisioner aboard knows where to find supplies — and the Admiralty watches every apothecary.",
    objectives:[
      "Identify the League Provisioner among the crew",
      "Arrange a supply of medicine without drawing attention",
      "Treat no one in a way that reveals your allegiance",
      "Report what you need to your Cell Foreman",
    ],
    win:{
      type:"meet",
      text:"Meet the League Provisioner and arrange supplies.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {role:"rebel_black_market_agent",label:"The League Provisioner"},
      ],
    },
    tips:[
      "Everyone trusts a doctor. Use that, but do not abuse it.",
      "Offer help before you ask for it. Provisioners remember kindness.",
      "Keep your supplies list to yourself. It tells a story.",
    ],
    suspectHint:"Provisioners are practical people. Offer to be useful before you ask for anything.",
    requires:"rebel_black_market_agent",
    knowsFaction: false,
  },
  telegraph_operator: {
    faction:"rebellion",
    title:"Telegraph Operator",
    subtitle:"Carrying the League's messages",
    icon:"✉️",
    cover:"Post-office clerk, bored on holiday",
    secret:"You keep the League’s messages moving — coded, quick, and quiet. They only work if you know exactly who to send them to: the Cell Foreman who gives the orders and the Cipher Clerk who decodes them.",
    objectives:[
      "Identify the Cell Foreman among the crew",
      "Identify the Cipher Clerk among the crew",
      "Pass messages without ever being seen to",
      "Burn anything that could be traced back to you",
    ],
    win:{
      type:"meet",
      text:"Meet both the Cell Foreman and the Cipher Clerk.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {role:"rebel_commander",label:"The Cell Foreman"},
        {role:"rebel_spy",label:"The Cipher Clerk"},
      ],
    },
    tips:[
      "A good operator is never seen. Speak little and listen often.",
      "Cell members have habits. Watch for the pattern before you approach.",
      "Never write down a name. Remember it, then forget you did.",
    ],
    suspectHint:"Cell members use small habits to recognise each other. Watch for the pattern.",
    requires:["rebel_commander","rebel_spy"],
    knowsFaction: false,
  },
  boiler_saboteur: {
    faction:"rebellion",
    title:"Boiler Saboteur",
    subtitle:"Where the pressure is highest",
    icon:"💥",
    cover:"Engineer studying the ship's boilers",
    secret:"You know every valve and pressure gauge, and exactly how to make an Admiralty machine fail at the worst moment. The Constable-General who runs the Admiralty's internal watch is the League's greatest threat — find them.",
    objectives:[
      "Identify the Admiralty Constable-General among the crew",
      "Observe before you act: a saboteur who is caught is useless",
      "Never carry tools that look out of place",
      "Report your finding to your Cell Foreman",
    ],
    win:{
      type:"identify",
      text:"Identify the Admiralty Constable-General.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {role:"imperial_security",label:"The Constable-General"},
      ],
    },
    tips:[
      "Watchers notice other watchers. Look for who looks back.",
      "Never carry a tool you cannot explain.",
      "Patience beats a spanner. Wait until you are sure.",
    ],
    suspectHint:"The Constable-General's job is watching people. They notice who else is watching.",
    requires:"imperial_security",
    knowsFaction: false,
  },
  // ── THE FREE TRADERS ────────────────────────────────────────────────────────────
  smuggler: {
    faction:"independent",
    title:"Aether Smuggler",
    subtitle:"Cargo first. Politics never.",
    icon:"🔮",
    cover:"Import-export consultant with flexible ethics",
    secret:"You move contraband aether crystals between ports and answer to no one — Admiralty or League. Right now you're carrying a cargo both sides want, and you need to offload it before they search the vessel.",
    objectives:[
      "Find a buyer for your cargo — Admiralty coin or League resources, you don't care",
      "Avoid Admiralty inspection by keeping suspicion off yourself",
      "Do not get caught in the crossfire between factions — neutrality is your survival",
      "If someone offers a better deal mid-voyage, take it",
    ],
    win:{
      type:"meet",
      text:"Meet the League Provisioner and sell your cargo.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {role:"rebel_black_market_agent",label:"The League buyer"},
      ],
    },
    tips:[
      "Everyone has a price. Find out what each side wants most.",
      "Neutrality is your armour. Never reveal which side offered more.",
      "A better deal mid-voyage beats loyalty. Keep your options open.",
    ],
    suspectHint:"Everyone has a price. Find it.",
    requires:"rebel_black_market_agent",
    knowsFaction: false,
  },
  arms_dealer: {
    faction:"independent",
    title:"Freelance Gunsmith",
    subtitle:"Neutral until the shooting starts",
    icon:"🔫",
    cover:"Technical supply representative on a sales tour",
    secret:"You forge and sell weapons to anyone who can pay, Admiralty and League alike, and neither must ever know about the other. Your talent is staying neutral — and staying alive.",
    objectives:[
      "Broker weapon deals with both Admiralty and League members without either knowing",
      "Identify who has resources to pay and what they urgently need",
      "Stay neutral — the moment you pick a side, the other side picks a price on your head",
      "Get paid and get out before the shooting starts",
    ],
    win:{
      type:"meet",
      text:"Meet the League Quartermaster and make the sale.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {role:"rebel_arms_buyer",label:"The League buyer"},
      ],
    },
    tips:[
      "Stay neutral. The moment you pick a side, the other puts a price on your head.",
      "Sell to both sides without either knowing about the other.",
      "Get paid first. Leave before the shooting starts.",
    ],
    suspectHint:"Anyone who asks too many questions about your clients is either a customer or a constable.",
    requires:"rebel_arms_buyer",
    knowsFaction: false,
  },
  information_broker: {
    faction:"independent",
    title:"Penny-Press Informant",
    subtitle:"Everyone talks to the newspapers",
    icon:"📰",
    cover:"Freelance journalist writing a feature on airship travel",
    secret:"You trade in secrets, selling what you learn to anyone who will pay. Knowing who is who aboard this vessel is worth more than any cargo — and your value drops to nothing if anyone learns what you do.",
    objectives:[
      "Discover the identities and objectives of as many crew members as possible",
      "Sell what you learn to the highest bidder — Admiralty, League, or Free Trader",
      "Never reveal you are an informant or your value drops to zero",
      "Make sure you're on the winning side's good side before the end",
    ],
    win:{
      type:"board",
      text:"Reach {n} correct on the Crew Suspect Board.",
      minShare:0.6,
    },
    tips:[
      "Everyone talks if you let them. Ask questions and listen more than you speak.",
      "Never give information away free. It is only valuable while it is rare.",
      "Stay on good terms with whoever is winning.",
    ],
    suspectHint:"Everyone talks if you let them. Ask questions. Listen more than you speak.",
    knowsFaction: false,
  },
  thief_taker: {
    faction:"independent",
    title:"Thief-Taker",
    subtitle:"Paid by whoever pays first",
    icon:"🎯",
    cover:"Gentleman of leisure with a keen eye for faces",
    secret:"You hunt for bounties, and two names are worth more than any others: the League's Cell Foreman and the Admiralty's Constable-General. Find both and you can sell the knowledge to whichever side pays more.",
    objectives:[
      "Identify the Cell Foreman among the crew",
      "Identify the Admiralty Constable-General among the crew",
      "Keep your interest in both a secret",
      "Sell what you know to the highest bidder",
    ],
    win:{
      type:"identify",
      text:"Identify both the Cell Foreman and the Constable-General.",
      proofHint:"A photo of the people you are naming, or the evidence that gave them away.",
      slots:[
        {role:"rebel_commander",label:"The Cell Foreman"},
        {role:"imperial_security",label:"The Constable-General"},
      ],
    },
    tips:[
      "Both sides pay well. Only one pays first. Wait for the better offer.",
      "Ask careful questions and listen to what is not said.",
      "Keep your interest in both targets a secret.",
    ],
    suspectHint:"Both sides are very careful. Ask careful questions and listen for what is not said.",
    requires:["rebel_commander","imperial_security"],
    knowsFaction: false,
  },
  free_cities_consul: {
    faction:"independent",
    title:"Consul of the Free Cities",
    subtitle:"A friend to every flag",
    icon:"🕊️",
    cover:"Diplomat travelling for pleasure",
    secret:"You represent the Free Cities, whose prosperity depends on staying friends with everyone. Your task is simple and difficult: sit down with the Admiralty, the League and the Free Traders alike.",
    objectives:[
      "Meet a member of the Admiralty",
      "Meet a member of the League",
      "Meet a fellow Free Trader",
      "Keep every side convinced you are on theirs",
    ],
    win:{
      type:"meet",
      text:"Meet one member of each faction.",
      proofHint:"A photo of you with the person you met.",
      slots:[
        {faction:"empire",count:1,share:0,label:"A member of the Admiralty"},
        {faction:"rebellion",count:1,share:0,label:"A member of the League"},
        {faction:"independent",count:1,share:0,label:"A fellow Free Trader"},
      ],
    },
    tips:[
      "Diplomacy is mostly listening. Let people tell you who they are.",
      "A friendly face opens every door. Use yours.",
      "Never tell any side what another one said.",
    ],
    suspectHint:"People will tell you which side they are on if you let them talk.",
    knowsFaction: false,
  },
};

// The roles that must be in play whenever `key` is: its `requires` and, transitively, theirs. A requirement can be one
// key or a list, and cycles are fine (a smuggler and the buyer who needs them require each other).
export function requiredRoles(key, roles = NARRATIVE_ROLES) {
  const seen = new Set();
  const stack = [key];
  while (stack.length) {
    for (const t of [].concat(roles[stack.pop()]?.requires || [])) {
      if (roles[t] && !seen.has(t)) { seen.add(t); stack.push(t); }
    }
  }
  seen.delete(key);
  return [...seen];
}

// Picks `count` role keys for random assignment such that every picked role's requirements (transitively) are picked too,
// so nobody is handed a mission with nobody to carry it out against. Roles are unique while count <= number of roles;
// beyond that they repeat, which is safe because every role is then in play.
export function pickRandomRoles(count, roles = NARRATIVE_ROLES, rand = Math.random) {
  const shuffle = (arr) => {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  const all = Object.keys(roles);
  const limit = Math.min(count, all.length);

  // Greedy, in random order. It can paint itself into a corner (the last free seat can't take a pair), so retry; a closed
  // set of every size exists, so a retry succeeds almost at once.
  let picked = [];
  for (let attempt = 0; attempt < 200; attempt++) {
    picked = [];
    const pool = shuffle(all);
    const missing = (k) => requiredRoles(k, roles).filter(t => !picked.includes(t));
    while (picked.length < limit && pool.length) {
      const free = limit - picked.length;
      const i = pool.findIndex(k => missing(k).length + 1 <= free);
      if (i < 0) break;
      const [k] = pool.splice(i, 1);
      for (const t of missing(k)) { picked.push(t); pool.splice(pool.indexOf(t), 1); }
      picked.push(k);
    }
    if (picked.length === limit) break;
  }

  const extras = shuffle(all);
  for (let n = 0; picked.length < count; n++) picked.push(extras[n % extras.length]);
  return shuffle(picked);
}

// Closing line for a game answer in the chat: the standing joke or a tip for the asker's own role, chosen at random.
// It only ever draws from the asker's own role, so one player's tip can't hint at what another player holds.
export function pickChatTip(roleKey, rand = Math.random) {
  const pool = [HUSS_TIP, ...(NARRATIVE_ROLES[roleKey]?.tips || [])];
  return `Tip: ${pool[Math.floor(rand() * pool.length)]}`;
}

// ── Missions: win conditions, claims and review ──────────────────────────────
// A role's `win` is one of: "meet" or "identify" (a claim with photo proof naming the people involved, approved by the
// organiser) or "board" (judged automatically from the player's Crew Suspect Board checks). The `win` in the role data is
// a template: `resolveWin` turns it into the concrete claim for this crew, scaling it up for bigger games. A claim slot
// names a `role` (that exact role) or a `faction` (any member of it). The player never learns whether a claim is right
// until the organiser has reviewed it, otherwise trying names one by one would reveal who holds which role.
export const winOf = (roleKey) => NARRATIVE_ROLES[roleKey]?.win || null;

export const LARGE_CREW = 12;       // players with roles from which the bigger versions of some wins unlock
export const FACTION_SHARE = 0.5;   // a faction win asks for this share of that faction's members...
export const FACTION_CAP = 5;       // ...but never more than this many people (and never fewer than the role's own minimum)
export const BOARD_CAP = 6;         // the board win never asks for more than this many correct in one check
export const MAX_CLAIM_ATTEMPTS = 3;

const peopleOf = (users) => Object.entries(users || {}).map(([id, u]) => ({ ...u, id }));
export const crewSize = (people) => (people || []).filter(p => NARRATIVE_ROLES[p?.narrativeRole]).length;
const fillText = (template, n) => String(template).replace(/\{n\}/g, n).replace(/\{s\}/g, n === 1 ? "" : "s");

// How many correct guesses in one check meet the board win: a share of the crew, capped so a big game stays winnable.
export function boardRequired(total, minShare) {
  if (!(total > 0)) return 0;
  return Math.max(1, Math.min(Math.ceil(minShare * total), BOARD_CAP));
}

// How many crew members must have a guess before the board can be checked: everyone in a small game, half in a big one
// (anyone left unmarked simply counts as wrong).
export function minMarkedToCheck(total) { return total <= 8 ? total : Math.ceil(total / 2); }

// The concrete win for one player in this crew. `people` is a list of user docs with ids. Faction slots grow with the
// number of players in that faction, and slots with `minCrew` only appear once the game is big enough.
export function resolveWin(roleKey, people, selfId) {
  const win = winOf(roleKey);
  if (!win) return null;
  const others = (people || []).filter(p => p.id !== selfId);
  if (win.type === "board") {
    const required = boardRequired(others.length, win.minShare);
    return { type: "board", text: fillText(win.text, required), required, slots: [] };
  }
  const size = crewSize(people);
  const holders = others.filter(p => NARRATIVE_ROLES[p.narrativeRole]);
  const slots = [];
  const extras = [];
  let scaled = null;
  for (const t of win.slots) {
    if (t.minCrew && size < t.minCrew) continue;
    if (t.role) {
      slots.push({ role: t.role, label: t.label });
    } else {
      const members = holders.filter(p => NARRATIVE_ROLES[p.narrativeRole].faction === t.faction).length;
      // a part that only unlocks in a big game is a fixed extra person; the main faction part is the one that grows
      const count = t.minCrew ? (t.count || 1) : Math.max(t.count || 1, Math.min(Math.ceil((t.share ?? FACTION_SHARE) * members), FACTION_CAP));
      if (scaled === null && !t.minCrew) scaled = count;
      for (let i = 1; i <= count; i++) slots.push({ faction: t.faction, label: count > 1 ? `${t.label} ${i}` : t.label });
    }
    if (t.minCrew && t.addText) extras.push(t.addText);
  }
  return { type: win.type, text: fillText(win.text, scaled ?? 1) + extras.join(""), proofHint: win.proofHint, slots };
}

// Why a role's win condition can't be completed with this crew, or null if it can.
export function unachievableWin(roleKey, people, selfId) {
  const win = resolveWin(roleKey, people, selfId);
  if (!win || win.type === "board") return null;
  const others = (people || []).filter(p => p.id !== selfId);
  const needed = {};
  for (const sl of win.slots) {
    if (sl.role) {
      if (!others.some(p => p.narrativeRole === sl.role)) return `no ${NARRATIVE_ROLES[sl.role].title} is assigned`;
    } else needed[sl.faction] = (needed[sl.faction] || 0) + 1;
  }
  for (const [f, n] of Object.entries(needed)) {
    const have = others.filter(p => NARRATIVE_ROLES[p.narrativeRole]?.faction === f).length;
    if (have < n) return `it needs ${n} ${NARRATIVE_FACTIONS[f].short} member${n === 1 ? "" : "s"} but only ${have} ${have === 1 ? "is" : "are"} assigned`;
  }
  return null;
}

// Checks a claim's picks (one player id per slot, in order) against the roles actually assigned. `slots` is the claim's own
// snapshot of what was asked; without one it is worked out from the crew as it is now.
export function evaluateClaim(roleKey, picks, users, selfUid, slots) {
  const list = slots?.length ? slots : resolveWin(roleKey, peopleOf(users), selfUid)?.slots || [];
  const results = list.map((sl, i) => {
    const id = picks?.[i];
    const u = id ? users?.[id] : null;
    if (!u || id === selfUid) return false;
    if (picks.indexOf(id) !== i) return false; // naming the same person twice only counts once
    if (sl.role) return u.narrativeRole === sl.role;
    if (sl.faction) return NARRATIVE_ROLES[u.narrativeRole]?.faction === sl.faction;
    return false;
  });
  return { slots: results, ok: list.length > 0 && results.every(Boolean) };
}

export function buildClaim({ id, claimantId, roleKey, picks, note, slots, winText, now = Date.now() }) {
  return { id, claimantId, roleKey, picks: [...picks], slots: slots || [], winText: winText || "", note: (note || "").trim().slice(0, 300), status: "pending", createdAt: now };
}

// `uncounted` returns the attempt a rejected claim used (for example when the photo was unclear).
export function reviewedClaim(claim, decision, note, reviewerId, now = Date.now(), uncounted = false) {
  return { ...claim, status: decision, reviewNote: (note || "").trim().slice(0, 300), reviewedBy: reviewerId, reviewedAt: now, ...(decision === "rejected" && uncounted ? { uncounted: true } : {}) };
}

// Where a player stands on their mission, from the shared list of claims.
export function missionStatus(uid, claims) {
  const mine = Object.values(claims || {}).filter(c => c && c.claimantId === uid);
  const approved = mine.find(c => c.status === "approved");
  if (approved) return { state: "approved", claim: approved };
  const pending = mine.find(c => c.status === "pending");
  if (pending) return { state: "pending", claim: pending };
  const rejected = mine.filter(c => c.status === "rejected").sort((a, b) => (b.reviewedAt || 0) - (a.reviewedAt || 0))[0];
  return rejected ? { state: "rejected", claim: rejected } : { state: "none", claim: null };
}

// Claims a player has made, other than rejected ones the organiser gave back.
export function attemptsUsed(uid, claims) {
  return Object.values(claims || {}).filter(c => c && c.claimantId === uid && !c.uncounted).length;
}
export const attemptsLeft = (uid, claims) => Math.max(0, MAX_CLAIM_ATTEMPTS - attemptsUsed(uid, claims));

// "board" missions are met automatically once any of the player's checks reaches the required number correct.
export function boardMissionMet(roleKey, score) {
  const win = winOf(roleKey);
  if (win?.type !== "board" || !score) return false;
  const checks = [{ correct: score.bestCorrect, total: score.bestTotal }, ...(Array.isArray(score.history) ? score.history : [])];
  return checks.some(c => c && c.total > 0 && c.correct <= c.total && c.correct >= boardRequired(c.total, win.minShare));
}

// How many missions are complete across the crew. A count only: naming who would hint at who holds a role.
export function completedMissionCount(users, claims, scores) {
  return Object.entries(users || {}).filter(([id, u]) => {
    const win = winOf(u?.narrativeRole);
    if (!win) return false;
    return win.type === "board" ? boardMissionMet(u.narrativeRole, scores?.[id]) : missionStatus(id, claims).state === "approved";
  }).length;
}

export const MAX_PROOF_FILE = 15 * 1024 * 1024;
export const MAX_PROOF_CHARS = 600000; // keeps a proof document well under Firestore's 1 MiB limit

// Turns a chosen photo into a small JPEG data URL. Phone photos are several MB, so unlike profile pictures this shrinks them
// rather than rejecting them. `compress` is a parameter so tests need no canvas.
export async function prepareProofPhoto(file, compress = compressImage) {
  if (!file || !/^image\//.test(file.type || "")) throw new Error("Please choose an image file.");
  if (file.size > MAX_PROOF_FILE) throw new Error("That photo is too large. Please choose one under 15 MB.");
  const dataUrl = await new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error("Couldn't read that photo."));
    r.readAsDataURL(file);
  });
  let out = await compress(dataUrl, 900, 0.6);
  if (out.length > MAX_PROOF_CHARS) out = await compress(dataUrl, 640, 0.5);
  if (out.length > MAX_PROOF_CHARS) throw new Error("Couldn't shrink that photo enough. Try a smaller one.");
  return out;
}

// Saves a claim. The photo goes in its own document (loaded only when someone opens it, so the shared claim list stays
// small) and is written first, so a reviewer never sees a claim without its photo. The claim keeps a snapshot of what was
// asked of the player, so reviewing it doesn't change if the crew does.
export async function submitMissionClaim({ claimantId, roleKey, picks, note, photo, users, claims }) {
  const win = resolveWin(roleKey, peopleOf(users), claimantId);
  if (!win || win.type === "board") throw new Error("Your mission doesn't use claims.");
  if (!photo) throw new Error("Add a proof photo first.");
  if (!Array.isArray(picks) || picks.length !== win.slots.length || picks.some(p => !p) || new Set(picks).size !== picks.length || picks.includes(claimantId)) {
    throw new Error("Pick a different crew member for each part of your mission.");
  }
  if (picks.some(p => !users?.[p])) throw new Error("One of the people you picked is no longer in the crew.");
  const { state } = missionStatus(claimantId, claims);
  if (state === "approved") throw new Error("Your mission is already complete.");
  if (state === "pending") throw new Error("You already have a claim waiting for review.");
  if (attemptsUsed(claimantId, claims) >= MAX_CLAIM_ATTEMPTS) throw new Error(`You've used all ${MAX_CLAIM_ATTEMPTS} of your attempts.`);
  const id = uid();
  const claim = buildClaim({ id, claimantId, roleKey, picks, note, slots: win.slots, winText: win.text });
  await fsSet("missionProofs", id, { id, claimantId, photo });
  await fsSet("missionClaims", id, claim);
  return claim;
}

// Approves or rejects a pending claim. An approval is refused unless the claim matches the assigned roles.
export async function reviewMissionClaim({ claim, decision, note, reviewerId, users, uncounted = false }) {
  if (decision !== "approved" && decision !== "rejected") throw new Error("Choose approve or reject.");
  if (claim?.status !== "pending") throw new Error("This claim has already been reviewed.");
  if (decision === "approved" && !evaluateClaim(claim.roleKey, claim.picks, users, claim.claimantId, claim.slots).ok) {
    throw new Error("This claim doesn't match the assigned roles, so it can't be approved.");
  }
  const next = reviewedClaim(claim, decision, note, reviewerId, Date.now(), uncounted);
  await fsSet("missionClaims", claim.id, next);
  return next;
}

// Gives a player back the attempt a rejected claim used.
export async function forgiveClaimAttempt(claim) {
  if (claim?.status !== "rejected") throw new Error("Only a rejected claim can be given back.");
  await fsSet("missionClaims", claim.id, { uncounted: true });
}

const GAME_CATS = ["Light","Medium","Heavy","Party","2 Player"];
const GAME_CAT_COLORS = {
  "Light":    {bg:"#162A1E",text:"#4ADE80",border:"#166534",icon:"🌿",glow:"#4ADE80"},
  "Medium":   {bg:"#1C1A0E",text:"#FCD34D",border:"#92400E",icon:"⚙️", glow:"#FCD34D"},
  "Heavy":    {bg:"#1A0E0E",text:"#F87171",border:"#991B1B",icon:"⚓", glow:"#F87171"},
  "Party":    {bg:"#1A0E28",text:"#C084FC",border:"#6D28D9",icon:"🎉",glow:"#C084FC"},
  "2 Player": {bg:"#0E1828",text:"#60A5FA",border:"#1E40AF",icon:"⚔️", glow:"#60A5FA"},
};

// ── Theme ────────────────────────────────────────────────────────────────────
// Steampunk palette: deep navy bg · warm brass accents · teal steam · copper highlights
const T = {
  // Backgrounds (darkest → lightest)
  bg:        "#0D1117",   // deep space black — main page bg
  bgMid:     "#161C2B",   // card bg
  surface:   "#1E2840",   // elevated surface
  surface2:  "#263450",   // input bg / secondary surface
  surface3:  "#2E3D5E",   // hover states
  // Borders
  border:    "#2E3D5E",   // subtle border — now distinct from surface2
  border2:   "#4A5B78",   // standard border — more visible
  borderGlow:"#D4A72C",   // accent border / highlight — brass gold
  // Text
  text:      "#F0F4FF",   // primary text — slightly warm white
  muted:     "#B8C4D8",   // secondary text — blue-grey
  hint:      "#7A8BA8",   // placeholder / tertiary — lifted for legibility
  // Primary accent — warm brass/amber (restored)
  amber:     "#D4A72C",   // brass gold
  amberSoft: "#1E1A08",   // dark amber tint bg
  amberGlow: "#F5C842",   // bright brass highlight
  // Secondary accent — copper warm mid-tone
  copper:    "#C07840",   // warm copper
  copperSoft:"#1C1208",   // dark copper tint bg
  // Tertiary accent — steam blue (unchanged, was working)
  steam:     "#93C5FD",   // sky blue
  steamSoft: "#0E1C38",   // dark blue tint
  teal:      "#5BBFB5",   // teal-cyan accent (restored)
  tealSoft:  "#091E1C",   // dark teal tint
  tealDim:   "#60A5FA",   // softer blue
  // Misc
  danger:    "#F87171",   // soft red
  dangerBg:  "#2a1515",   // dark red bg
  ink:       "#0D1117",
  mist:      "#7A8BA8",   // same as hint — lifted
  mistSoft:  "#1E2840",
  gold:      "#D4A72C",   // same as amber — true brass
  goldSoft:  "#1E1A08",
};

// ── Helpers ───────────────────────────────────────────────────────────────────
export const getInitials = (n="") => n.split(" ").map(w=>w[0]).join("").toUpperCase().slice(0,2)||"?";
export const avColor     = (n="") => AV_COLORS[(n.charCodeAt(0)||0)%AV_COLORS.length];
export const uid         = ()     => Date.now().toString(36)+Math.random().toString(36).slice(2,7);
export const fsSet = (col,id,data) => setDoc(doc(db,col,id), data, {merge:true});
export const fsDel = (col,id)      => deleteDoc(doc(db,col,id));
export const subCol = (name,set)   => onSnapshot(collection(db,name), s=>{const d={};s.forEach(x=>d[x.id]=x.data());set(d);});
export const sumAmount = list      => list.reduce((s,r)=>s+(parseFloat(r.amount)||0),0);

// ── Image upload hook with size validation ────────────────────────────────────
export function useImageUpload() {
  const fileRef  = useRef();
  const [imgErr, setImgErr] = useState("");
  const pickImage = (onResult) => {
    setImgErr("");
    fileRef.current.value = "";
    fileRef.current.onchange = e => {
      const f = e.target.files[0]; if(!f) return;
      if(f.size > MAX_IMG) {
        setImgErr(`Image too large — ${(f.size/1024).toFixed(0)} KB. Maximum is 800 KB. Please resize and try again.`);
        fileRef.current.value = "";
        return;
      }
      const r = new FileReader();
      r.onload = ev => { setImgErr(""); onResult(ev.target.result); };
      r.readAsDataURL(f);
    };
    fileRef.current.click();
  };
  // Stable component identity: a fresh function each render would remount the <input> and drop a pending file pick
  const Input = useCallback(() => <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}}/>, []);
  return { pickImage, imgErr, setImgErr, Input };
}

// ── SVG Steampunk Background ──────────────────────────────────────────────────
function SteampunkBg() {
  return (
    <div style={{position:"fixed",inset:0,zIndex:0,overflow:"hidden",pointerEvents:"none"}}>
      <svg viewBox="0 0 1400 800" style={{width:"100%",height:"100%",opacity:.22}} preserveAspectRatio="xMidYMid slice">
        {/* Sky gradient bands */}
        <defs>
          <linearGradient id="skyG" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#0D1117"/>
            <stop offset="50%" stopColor="#101825"/>
            <stop offset="100%" stopColor="#080C12"/>
          </linearGradient>
          <linearGradient id="brassG" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#2E3D5E"/>
            <stop offset="50%" stopColor="#D4A72C"/>
            <stop offset="100%" stopColor="#2E3D5E"/>
          </linearGradient>
          <radialGradient id="glowG" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="#D4A72C" stopOpacity="0.5"/>
            <stop offset="100%" stopColor="#D4A72C" stopOpacity="0"/>
          </radialGradient>
          <filter id="blur2"><feGaussianBlur stdDeviation="2"/></filter>
          <filter id="blur4"><feGaussianBlur stdDeviation="4"/></filter>
        </defs>

        <rect width="1400" height="800" fill="url(#skyG)"/>

        {/* Stars */}
        {[[80,60],[200,30],[350,90],[500,20],[680,70],[820,40],[950,80],[1100,25],[1250,60],[1350,45],
          [150,140],[400,160],[700,120],[1050,150],[1300,130],[50,200],[320,220],[600,180],[900,210]].map(([x,y],i)=>(
          <circle key={i} cx={x} cy={y} r={i%3===0?2:1.2} fill="#F9FAFB" opacity={.4+Math.random()*.3}/>
        ))}

        {/* Moon / porthole glow */}
        <circle cx="1150" cy="100" r="55" fill="#111827" stroke="#D4A72C" strokeWidth="3"/>
        <circle cx="1150" cy="100" r="48" fill="#1F2937" opacity=".9"/>
        <circle cx="1150" cy="100" r="42" fill="url(#glowG)"/>
        {/* Porthole rivets */}
        {[0,45,90,135,180,225,270,315].map((deg,i)=>{
          const rad = deg*Math.PI/180;
          return <circle key={i} cx={1150+57*Math.cos(rad)} cy={100+57*Math.sin(rad)} r="3.5" fill="#C8A020"/>;
        })}

        {/* Large floating airship 1 */}
        <g transform="translate(180,180)">
          {/* Envelope / balloon */}
          <ellipse cx="0" cy="-30" rx="130" ry="45" fill="#2A1F0A" stroke="#D4A72C" strokeWidth="1.5"/>
          <ellipse cx="0" cy="-30" rx="125" ry="40" fill="#374151"/>
          {/* Balloon ribs */}
          {[-80,-40,0,40,80].map((x,i)=>(
            <ellipse key={i} cx={x} cy="-30" rx="6" ry="40" fill="none" stroke="#D4A72C" strokeWidth=".8" opacity=".5"/>
          ))}
          {/* Gondola */}
          <rect x="-70" y="22" width="140" height="36" rx="8" fill="#374151" stroke="#D4A72C" strokeWidth="1.5"/>
          <rect x="-65" y="26" width="130" height="28" rx="6" fill="#374151"/>
          {/* Windows on gondola */}
          {[-40,0,40].map((x,i)=>(
            <g key={i}>
              <circle cx={x} cy="40" r="9" fill="#1e3a5f" stroke="#D4A72C" strokeWidth="1.2"/>
              <circle cx={x} cy="40" r="6" fill="#93C5FD" opacity=".3"/>
              {[0,90,180,270].map((d,j)=>{
                const r2=d*Math.PI/180;
                return <circle key={j} cx={x+10*Math.cos(r2)} cy={40+10*Math.sin(r2)} r="1.5" fill="#C8A020"/>;
              })}
            </g>
          ))}
          {/* Rigging ropes */}
          {[-60,-30,30,60].map((x,i)=>(
            <line key={i} x1={x*0.9} y1="-5" x2={x} y2="22" stroke="#6B7280" strokeWidth="1" opacity=".7"/>
          ))}
          {/* Propeller */}
          <circle cx="80" cy="40" r="5" fill="#C8A020"/>
          <ellipse cx="80" cy="40" rx="2" ry="18" fill="#374151" stroke="#D4A72C" strokeWidth=".8" transform="rotate(30,80,40)"/>
          <ellipse cx="80" cy="40" rx="2" ry="18" fill="#374151" stroke="#D4A72C" strokeWidth=".8" transform="rotate(150,80,40)"/>
          {/* Steam puffs */}
          <ellipse cx="-90" cy="35" rx="18" ry="10" fill="#93C5FD" opacity=".25"/>
          <ellipse cx="-110" cy="28" rx="14" ry="8" fill="#93C5FD" opacity=".18"/>
          <ellipse cx="-125" cy="22" rx="10" ry="6" fill="#93C5FD" opacity=".12"/>
          {/* Anchor */}
          <line x1="-20" y1="58" x2="-20" y2="85" stroke="#374151" strokeWidth="1.5" strokeDasharray="3,2"/>
          <circle cx="-20" cy="88" r="4" fill="#6B7280"/>
        </g>

        {/* Floating island with cogs */}
        <g transform="translate(700,100)">
          {/* Island body */}
          <ellipse cx="0" cy="60" rx="160" ry="40" fill="#1C2333"/>
          <ellipse cx="0" cy="55" rx="150" ry="35" fill="#374151"/>
          <rect x="-140" y="20" width="280" height="40" rx="20" fill="#111827"/>
          <ellipse cx="0" cy="20" rx="120" ry="38" fill="#1C2333"/>
          {/* Brass pipes on island */}
          <rect x="-50" y="-10" width="12" height="35" rx="4" fill="#C8A020"/>
          <rect x="-30" y="-20" width="12" height="45" rx="4" fill="#6B7280"/>
          <rect x="20" y="-5" width="12" height="30" rx="4" fill="#C8A020"/>
          {/* Steam from pipes */}
          <ellipse cx="-44" cy="-14" rx="12" ry="8" fill="#93C5FD" opacity=".3"/>
          <ellipse cx="-24" cy="-24" rx="10" ry="7" fill="#93C5FD" opacity=".25"/>
          <ellipse cx="26" cy="-9" rx="10" ry="7" fill="#93C5FD" opacity=".25"/>
          {/* Gear on island */}
          <circle cx="70" cy="10" r="22" fill="none" stroke="#D4A72C" strokeWidth="3"/>
          <circle cx="70" cy="10" r="14" fill="#374151" stroke="#6B7280" strokeWidth="2"/>
          <circle cx="70" cy="10" r="5" fill="#C8A020"/>
          {[0,30,60,90,120,150,180,210,240,270,300,330].map((d,i)=>{
            const rad=d*Math.PI/180;
            return <rect key={i} x={70+18*Math.cos(rad)-2} y={10+18*Math.sin(rad)-5} width="4" height="10" rx="1" fill="#C8A020" transform={`rotate(${d},${70+18*Math.cos(rad)},${10+18*Math.sin(rad)})`}/>;
          })}
          {/* Small gear */}
          <circle cx="98" cy="10" r="12" fill="none" stroke="#6B7280" strokeWidth="2"/>
          <circle cx="98" cy="10" r="7" fill="#374151" stroke="#374151" strokeWidth="1.5"/>
          <circle cx="98" cy="10" r="3" fill="#6B7280"/>
          {[0,45,90,135,180,225,270,315].map((d,i)=>{
            const rad=d*Math.PI/180;
            return <rect key={i} x={98+9*Math.cos(rad)-1.5} y={10+9*Math.sin(rad)-3.5} width="3" height="7" rx=".5" fill="#6B7280" transform={`rotate(${d},${98+9*Math.cos(rad)},${10+9*Math.sin(rad)})`}/>;
          })}
          {/* Chains hanging */}
          {[-80,-40].map((x,i)=>(
            <g key={i}>
              {[0,8,16,24,32,40].map((y2,j)=>(
                <ellipse key={j} cx={x} cy={75+y2} rx="4" ry="3" fill="none" stroke="#374151" strokeWidth="1.5"/>
              ))}
            </g>
          ))}
        </g>

        {/* Second smaller airship */}
        <g transform="translate(1050,300) scale(0.7) rotate(-5)">
          <ellipse cx="0" cy="-30" rx="110" ry="38" fill="#2A1F0A" stroke="#6B7280" strokeWidth="1.5"/>
          <ellipse cx="0" cy="-30" rx="105" ry="33" fill="#374151"/>
          {[-60,-20,20,60].map((x,i)=>(
            <ellipse key={i} cx={x} cy="-30" rx="5" ry="33" fill="none" stroke="#6B7280" strokeWidth=".8" opacity=".5"/>
          ))}
          <rect x="-55" y="15" width="110" height="30" rx="7" fill="#374151" stroke="#6B7280" strokeWidth="1.5"/>
          <rect x="-50" y="19" width="100" height="22" rx="5" fill="#374151"/>
          {[-25,25].map((x,i)=>(
            <circle key={i} cx={x} cy="30" r="7" fill="#1e3a5f" stroke="#6B7280" strokeWidth="1"/>
          ))}
          {[-45,-20,20,45].map((x,i)=>(
            <line key={i} x1={x*.9} y1="-2" x2={x} y2="15" stroke="#374151" strokeWidth=".8" opacity=".7"/>
          ))}
          <circle cx="65" cy="30" r="4" fill="#6B7280"/>
          <ellipse cx="65" cy="30" rx="1.5" ry="13" fill="#374151" stroke="#6B7280" strokeWidth=".6" transform="rotate(20,65,30)"/>
          <ellipse cx="65" cy="30" rx="1.5" ry="13" fill="#374151" stroke="#6B7280" strokeWidth=".6" transform="rotate(140,65,30)"/>
          <ellipse cx="-75" cy="26" rx="14" ry="7" fill="#93C5FD" opacity=".2"/>
          <ellipse cx="-90" cy="20" rx="10" ry="5" fill="#93C5FD" opacity=".15"/>
        </g>

        {/* Tiny distant airship */}
        <g transform="translate(400,440) scale(0.35) rotate(3)">
          <ellipse cx="0" cy="-30" rx="110" ry="38" fill="#374151" stroke="#374151" strokeWidth="1.5"/>
          <rect x="-55" y="15" width="110" height="30" rx="7" fill="#111827" stroke="#374151" strokeWidth="1.5"/>
          <ellipse cx="-80" cy="26" rx="16" ry="8" fill="#93C5FD" opacity=".2"/>
        </g>

        {/* Floating gear cluster bottom left */}
        <g transform="translate(60,580)">
          <circle cx="0" cy="0" r="55" fill="none" stroke="#374151" strokeWidth="4"/>
          <circle cx="0" cy="0" r="38" fill="#111827" stroke="#253044" strokeWidth="2"/>
          <circle cx="0" cy="0" r="12" fill="#C8A020"/>
          {[0,24,48,72,96,120,144,168,192,216,240,264,288,312,336].map((d,i)=>{
            const rad=d*Math.PI/180;
            return <rect key={i} x={-2+46*Math.cos(rad)} y={-7+46*Math.sin(rad)} width="4" height="14" rx="1" fill="#374151" transform={`rotate(${d},${46*Math.cos(rad)},${46*Math.sin(rad)})`}/>;
          })}
          <circle cx="65" cy="-20" r="30" fill="none" stroke="#253044" strokeWidth="3"/>
          <circle cx="65" cy="-20" r="18" fill="#111827" stroke="#1C2333" strokeWidth="2"/>
          <circle cx="65" cy="-20" r="6" fill="#6B7280"/>
          {[0,40,80,120,160,200,240,280,320].map((d,i)=>{
            const rad=d*Math.PI/180;
            return <rect key={i} x={-2+24*Math.cos(rad)+65} y={-4+24*Math.sin(rad)-20} width="4" height="8" rx="1" fill="#253044" transform={`rotate(${d},${24*Math.cos(rad)+65},${24*Math.sin(rad)-20})`}/>;
          })}
        </g>

        {/* Steam pipes bottom right */}
        <g transform="translate(1280,500)">
          <rect x="0" y="-60" width="20" height="120" rx="5" fill="#374151" stroke="#374151" strokeWidth="2"/>
          <rect x="30" y="-80" width="20" height="140" rx="5" fill="#374151" stroke="#374151" strokeWidth="2"/>
          <rect x="60" y="-40" width="20" height="100" rx="5" fill="#374151" stroke="#374151" strokeWidth="2"/>
          {/* Pipe connectors */}
          <rect x="0" y="-10" width="50" height="12" rx="3" fill="#374151" stroke="#374151" strokeWidth="1.5"/>
          <rect x="30" y="20" width="50" height="12" rx="3" fill="#374151" stroke="#374151" strokeWidth="1.5"/>
          {/* Valve wheels */}
          <circle cx="10" cy="-25" r="12" fill="none" stroke="#D4A72C" strokeWidth="2"/>
          <line x1="10" y1="-37" x2="10" y2="-13" stroke="#D4A72C" strokeWidth="2"/>
          <line x1="-2" y1="-25" x2="22" y2="-25" stroke="#D4A72C" strokeWidth="2"/>
          <circle cx="40" cy="-50" r="10" fill="none" stroke="#6B7280" strokeWidth="2"/>
          <line x1="40" y1="-60" x2="40" y2="-40" stroke="#6B7280" strokeWidth="2"/>
          <line x1="30" y1="-50" x2="50" y2="-50" stroke="#6B7280" strokeWidth="2"/>
          {/* Steam */}
          {[[10,-40],[40,-62],[70,-42]].map(([x,y],i)=>(
            <g key={i}>
              <ellipse cx={x} cy={y-8} rx="12" ry="8" fill="#93C5FD" opacity=".25"/>
              <ellipse cx={x+4} cy={y-18} rx="9" ry="6" fill="#93C5FD" opacity=".18"/>
              <ellipse cx={x-2} cy={y-27} rx="7" ry="5" fill="#93C5FD" opacity=".12"/>
            </g>
          ))}
        </g>

        {/* Rope bridge between island and edge */}
        <path d="M560,140 Q630,200 700,135" stroke="#6B7280" strokeWidth="2" fill="none" opacity=".4" strokeDasharray="6,4"/>
        <path d="M700,140 Q780,200 850,160" stroke="#374151" strokeWidth="1.5" fill="none" opacity=".3" strokeDasharray="5,3"/>

        {/* Distant flying whale silhouette */}
        <g transform="translate(900,520) rotate(-6) scale(0.5)">
          <ellipse cx="0" cy="0" rx="100" ry="30" fill="#93C5FD" opacity=".2"/>
          <path d="M100,0 Q130,-22 118,-36 Q112,-12 130,6 Q112,22 118,36 Q130,24 100,0Z" fill="#93C5FD" opacity=".2"/>
          <path d="M-10,-30 Q12,-58 35,-44 Q18,-30 -10,-30Z" fill="#93C5FD" opacity=".15"/>
          <circle cx="-60" cy="-6" r="5" fill="#C8A020" opacity=".3"/>
          {/* Goggles / porthole on whale */}
          <circle cx="-55" cy="-6" r="8" fill="none" stroke="#D4A72C" strokeWidth="1.5" opacity=".4"/>
        </g>

        {/* Horizontal brass rule lines */}
        <line x1="0" y1="750" x2="1400" y2="750" stroke="#D4A72C" strokeWidth="1" opacity=".15"/>
        <line x1="0" y1="760" x2="1400" y2="760" stroke="#374151" strokeWidth=".5" opacity=".1"/>
      </svg>
    </div>
  );
}

// ── Shared UI ─────────────────────────────────────────────────────────────────
export function Avatar({name="?",picture,size=72}){
  if(picture) return <img src={picture} alt={name} style={{width:size,height:size,borderRadius:"50%",objectFit:"cover",border:`2px solid ${T.amber}`,flexShrink:0}}/>;
  return <div style={{width:size,height:size,borderRadius:"50%",background:avColor(name),display:"flex",alignItems:"center",justifyContent:"center",color:T.text,fontSize:size*.36,fontWeight:700,border:`2px solid ${T.border2}`,flexShrink:0}}>{getInitials(name)}</div>;
}

export function Btn({children,variant="primary",size="md",style={},disabled,onClick}){
  const V={
    primary: {background:`linear-gradient(135deg,${T.amber},${T.amberGlow})`,color:"#111827",border:"none",boxShadow:`0 2px 12px ${T.amber}44`},
    ghost:   {background:"transparent",color:T.text,border:`2px solid ${T.border2}`},
    copper:  {background:`linear-gradient(135deg,${T.copper},#D4703A)`,color:"#fff",border:"none"},
    danger:  {background:"transparent",color:T.danger,border:`1.5px solid ${T.danger}55`},
  };
  const S={sm:{fontSize:12,padding:"5px 12px"},md:{fontSize:14,padding:"9px 20px"},lg:{fontSize:15,padding:"11px 24px"}};
  return <button disabled={disabled} onClick={onClick}
    style={{fontFamily:"'Cinzel',serif",fontWeight:600,borderRadius:6,cursor:disabled?"not-allowed":"pointer",transition:"all .15s",display:"inline-flex",alignItems:"center",justifyContent:"center",gap:6,opacity:disabled?.5:1,letterSpacing:".03em",...S[size],...V[variant],...style}}>
    {children}
  </button>;
}

export function Inp({label,error,containerStyle={},style={},...p}){
  return <div style={{display:"flex",flexDirection:"column",gap:4,...containerStyle}}>
    {label&&<span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em"}}>{label}</span>}
    <input style={{fontFamily:"inherit",fontSize:14,padding:"9px 12px",borderRadius:6,border:`2px solid ${error?T.danger:T.border2}`,background:T.surface2,color:T.text,outline:"none",width:"100%",...style}}
      {...p}/>
    {error&&<span style={{fontSize:12,color:T.danger,lineHeight:1.4}}>{error}</span>}
  </div>;
}

function Sel({label,children,...p}){
  return <div style={{display:"flex",flexDirection:"column",gap:4}}>
    {label&&<span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em"}}>{label}</span>}
    <select style={{fontFamily:"inherit",fontSize:14,padding:"9px 12px",borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,color:T.text,outline:"none",appearance:"none",cursor:"pointer"}} {...p}>{children}</select>
  </div>;
}

function Rivet({style={}}){
  return <svg width="16" height="16" viewBox="0 0 13 13" style={{position:"absolute",flexShrink:0,...style}}>
    <polygon points="6.5,1 11.6,3.9 11.6,9.1 6.5,12 1.4,9.1 1.4,3.9" fill={T.surface3} stroke={T.borderGlow} strokeWidth="1.6"/>
    <circle cx="6.5" cy="6.5" r="2.5" fill={T.amber} opacity=".85"/>
    <circle cx="6.5" cy="6.5" r="1" fill={T.amberGlow} opacity=".6"/>
  </svg>;
}

const Card = React.forwardRef(function Card({children,style={}},ref){
  return <div ref={ref} style={{background:T.surface,border:`3px solid ${T.border2}`,borderRadius:8,padding:"18px 20px",position:"relative",
    backgroundImage:`linear-gradient(135deg,${T.surface} 0%,${T.surface2} 100%)`,
    boxShadow:`inset 0 1px 0 ${T.borderGlow}44, 0 4px 16px rgba(0,0,0,.5), 0 0 0 1px ${T.borderGlow}22`,...style}}>
    <Rivet style={{top:-2,left:-2}}/>
    <Rivet style={{top:-2,right:-2}}/>
    <Rivet style={{bottom:-2,left:-2}}/>
    <Rivet style={{bottom:-2,right:-2}}/>
    {children}
  </div>;
});

function Toast({msg,onDone}){
  useEffect(()=>{const t=setTimeout(onDone,4500);return()=>clearTimeout(t);},[]);
  const isPush  = typeof msg==="string" && msg.startsWith("🔔 ");
  const content = isPush ? msg.slice(2).trim() : msg;
  const colon   = isPush ? content.indexOf(": ") : -1;
  const title   = colon>-1 ? content.slice(0,colon) : content;
  const body    = colon>-1 ? content.slice(colon+2) : null;
  return (
    <div onClick={onDone} style={{
      position:"fixed",
      bottom:`max(24px, calc(env(safe-area-inset-bottom) + 12px))`,
      left:"50%", transform:"translateX(-50%)",
      background:T.surface, border:`2px solid ${T.border2}`,
      borderRadius:10, padding:"12px 18px",
      zIndex:9999, cursor:"pointer",
      boxShadow:`0 4px 32px rgba(0,0,0,.6), 0 0 0 1px ${T.borderGlow}22`,
      maxWidth:"calc(100vw - 32px)", width:"max-content",
      animation:"ccFade .25s ease",
    }}>
      <div style={{display:"flex",alignItems:"flex-start",gap:10}}>
        {isPush&&<span style={{fontSize:20,flexShrink:0,lineHeight:1.3}}>🔔</span>}
        <div style={{minWidth:0}}>
          <div style={{fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,color:T.text,
            letterSpacing:".04em",lineHeight:1.3,
            whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:"58vw"}}>
            {title}
          </div>
          {body&&<div style={{fontSize:12,color:T.muted,marginTop:3,lineHeight:1.4,
            whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis",maxWidth:"58vw"}}>
            {body}
          </div>}
        </div>
        <span style={{fontSize:11,color:T.hint,flexShrink:0,alignSelf:"center",marginLeft:4}}>✕</span>
      </div>
    </div>
  );
}

function Spinner({label="Loading…"}){
  return <div style={{display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",minHeight:"100vh",gap:14,background:T.bg}}>
    <div style={{width:40,height:40,border:`3px solid ${T.border}`,borderTop:`3px solid ${T.amber}`,borderRadius:"50%",animation:"ccSpin .8s linear infinite"}}/>
    <span style={{fontSize:14,fontFamily:"'Cinzel',serif",color:T.amber,letterSpacing:".08em"}}>{label}</span>
  </div>;
}

function SectionTitle({children,sub}){
  return <div style={{marginBottom:20}}>
    <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:sub?4:0}}>
      <div style={{height:2,width:24,background:`linear-gradient(90deg,${T.amber},transparent)`}}/>
      <h2 style={{fontFamily:"'Cinzel',serif",fontSize:"clamp(16px,4vw,20px)",fontWeight:700,color:T.amber,letterSpacing:".05em",margin:0}}>{children}</h2>
      <div style={{height:2,flex:1,background:`linear-gradient(90deg,${T.amber},transparent)`,maxWidth:80}}/>
    </div>
    {sub&&<p style={{color:T.muted,fontSize:13,marginTop:4,paddingLeft:34}}>{sub}</p>}
  </div>;
}

export function Chip({children,color="default"}){
  const c={
    default:{bg:T.surface2,text:T.muted,border:T.border},
    amber:  {bg:T.amberSoft,text:T.amber,border:T.border2},
    copper: {bg:T.copperSoft,text:T.copper,border:T.copper+"66"},
    steam:  {bg:T.steamSoft,text:T.steam,border:T.steam+"44"},
  }[color]||{bg:T.surface2,text:T.muted,border:T.border};
  return <span style={{display:"inline-block",fontSize:11,padding:"3px 9px",borderRadius:4,background:c.bg,color:c.text,border:`1px solid ${c.border}`,fontWeight:500}}>{children}</span>;
}

function GearLogo({size=48}){
  // Steampunk gear-dice: outer gear ring with teeth + inner dice face
  const s=size, cx=s/2, cy=s/2;
  const toothW=s*.065, toothH=s*.14, outerR=s*.42, innerR=s*.31;
  const numTeeth=12;
  // Build gear teeth as small rects around the ring
  const teeth=Array.from({length:numTeeth}).map((_,i)=>{
    const angle=(i/numTeeth)*Math.PI*2 - Math.PI/2;
    const tx=cx+outerR*Math.cos(angle);
    const ty=cy+outerR*Math.sin(angle);
    return {tx,ty,angle:angle*180/Math.PI+90};
  });
  // Dice pips at corners
  const diceSize=s*.38, diceX=cx-diceSize/2, diceY=cy-diceSize/2;
  const pip=s*.055;
  const pipOff=diceSize*.22;
  const pips=[[-1,-1],[1,-1],[-1,1],[1,1]].map(([dx,dy])=>({x:cx+dx*pipOff,y:cy+dy*pipOff}));
  return <svg width={s} height={s} viewBox={`0 0 ${s} ${s}`}>
    {/* Outer ring */}
    <circle cx={cx} cy={cy} r={outerR} fill="none" stroke={T.amber} strokeWidth={s*.04}/>
    {/* Teeth */}
    {teeth.map((t,i)=><rect key={i}
      x={t.tx-toothW/2} y={t.ty-toothH/2}
      width={toothW} height={toothH} rx={toothW*.3}
      fill={T.amber}
      transform={`rotate(${t.angle},${t.tx},${t.ty})`}
    />)}
    {/* Inner fill */}
    <circle cx={cx} cy={cy} r={innerR} fill={T.surface} stroke={T.border2} strokeWidth={s*.025}/>
    {/* Dice body */}
    <rect x={diceX} y={diceY} width={diceSize} height={diceSize} rx={diceSize*.15}
      fill={T.bgMid} stroke={T.amber} strokeWidth={s*.03}/>
    {/* Dice pips */}
    {pips.map((p,i)=><circle key={i} cx={p.x} cy={p.y} r={pip} fill={T.amber}/>)}
    {/* Center hub */}
    <circle cx={cx} cy={cy} r={s*.055} fill={T.amber}/>
  </svg>;
}

function BrassRule(){
  return <div style={{display:"flex",alignItems:"center",gap:8,margin:"6px 0"}}>
    <div style={{flex:1,height:1,background:`linear-gradient(90deg,transparent,${T.border2})`}}/>
    <div style={{width:6,height:6,borderRadius:"50%",background:T.amber}}/>
    <div style={{flex:1,height:1,background:`linear-gradient(90deg,${T.border2},transparent)`}}/>
  </div>;
}

export function DietPills({selected,onToggle}){
  return <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
    {DIETARY.map(d=><button key={d} onClick={()=>onToggle(d)}
      style={{fontFamily:"inherit",fontSize:12,padding:"4px 11px",borderRadius:4,border:`1.5px solid ${selected.includes(d)?T.amber:T.border}`,background:selected.includes(d)?T.amberSoft:T.surface2,color:selected.includes(d)?T.amber:T.muted,cursor:"pointer",transition:"all .15s"}}>
      {d}
    </button>)}
  </div>;
}

// ── Main App ──────────────────────────────────────────────────────────────────

// ── Onboarding Modal ──────────────────────────────────────────────────────────
export function OnboardingModal({ctx}){
  const {profile,doUpdateProfile}=ctx;

  // Show when profile exists and onboarded is explicitly false
  const [show,setShow]=useState(profile?.onboarded===false);
  const [page,setPage]=useState(0);

  if(!show) return null;

  const dismiss=async()=>{
    setShow(false);
    await doUpdateProfile({...profile,onboarded:true});
  };

  const PAGES=[
    {
      icon:"⚙️",
      title:"Welcome aboard, " + (profile?.name?.split(" ")[0]||"Crew") + "!",
      subtitle:"Cottage Con · Nov 26–29 · The Yellow Cottage",
      body:"This app is your digital companion for the weekend — track games, coordinate food, sign up for duties, and follow the itinerary. Here's a quick tour of each section.",
      note:"A secret war is being fought aboard this voyage. The Admiralty, the Gearwrights' League, and the Free Traders who answer to neither are all among the crew. Trust carefully.",
      color:T.amber,
    },
    {
      icon:"🎲",
      title:"Bridge",
      subtitle:"Your mission control",
      body:"The Bridge is your home screen. It shows the countdown to departure, crew stats, and a live leaderboard of the most voted games. Tap any stat card to jump to that section.",
      note:"Watch the votes. Allegiances have a way of showing up in the strangest places.",
      color:T.amber,
    },
    {
      icon:"🗓",
      title:"Itinerary",
      subtitle:"The voyage plan",
      body:"See the full weekend schedule — check-in details, the cottage address with a map, and day-by-day activities. The Engine Room lets the organiser update this live.",
      note:"Every gathering is a chance to share a secret — or steal one.",
      color:T.steam,
    },
    {
      icon:"📦",
      title:"Cargo Hold",
      subtitle:"Board game library",
      body:"Browse all the games being brought to the cottage. Vote for the ones you want to play, request games nobody owns yet, and filter by weight category — Light, Medium, Heavy, Party, or 2-Player.",
      note:"Crates have false bottoms. Mind what's really in the hold.",
      color:"#FCD34D",
    },
    {
      icon:"🍲",
      title:"Galley",
      subtitle:"Food, gear & menu",
      body:"Log what food and supplies you're bringing so the group can coordinate. The Voyage Menu lets everyone plan breakfast, lunch, and dinner for each day.",
      note:"Even spies get hungry. A shared meal loosens tongues.",
      color:"#4ADE80",
    },
    {
      icon:"⚓",
      title:"Deck Hands",
      subtitle:"Duties & crew roster",
      body:"Sign up for preparation and cleanup slots each day. You'll see the full crew roster here too, with everyone's rank — Officer (adult), Enlisted (kid), or Stowaway (day visitor).",
      note:"A duty roster makes a fine alibi — and a fine way to learn who is busy, and when.",
      color:T.muted,
    },
    {
      icon:"📜",
      title:"Manifest",
      subtitle:"Expense tracking",
      body:"Snap a photo of any shared receipts. The Manifest tracks who paid for what and keeps a running total so splitting costs at the end is easy.",
      note:"Receipts don't lie. People do.",
      color:T.copper,
    },
    {
      icon:"🏴‍☠️",
      title:"Crew Assistant",
      subtitle:"Your sky-pirate automaton",
      body:"Tap the 🏴‍☠️ button floating in the bottom-right corner of any page to chat with the AI assistant. Ask it what to play, who's bringing what, the schedule, game rules — it reads your crew's live data and answers fast.",
      note:"It keeps your secrets, and now and then slips you a tip for your own mission.",
      color:T.steam,
    },
    {
      icon:"👤",
      title:"Personal Log",
      subtitle:"Your profile",
      body:"Set your display name, profile photo, crew rank, and dietary restrictions. Your Personal Log also shows all your games, galley items, and duty assignments in one place — and it's where your classified dossier is kept.",
      note:"A cover story starts with a name and a face. Choose yours wisely.",
      color:"#C084FC",
    },
    {
      icon:"📁",
      title:"Your Dossier",
      subtitle:"A classified mission — eyes only",
      body:"Crew members may be handed a secret role. If you are one of them, your sealed dossier waits at the top of your Personal Log. Tap it to read your cover story, objectives and orders, and make sure no one is looking over your shoulder. It also holds your win condition: claim it with a photo as proof. You get 3 attempts.",
      note:"Never show your dossier to anyone. Not even a friend. Especially not a friend.",
      color:"#F87171",
    },
    {
      icon:"🗂️",
      title:"Crew Suspect Board",
      subtitle:"Trust no one",
      body:"Inside your dossier, mark who you think holds which role for every other crew member. Once enough of the crew is marked, tap Check my guesses to see how many you got right. Better scores with fewer checks climb the leaderboard.",
      note:"Your guesses stay private on your device. The leaderboard shows scores only, never who guessed what.",
      color:T.steam,
    },
    (() => {
      const ua = navigator.userAgent;
      const isIOS     = /iPad|iPhone|iPod/.test(ua) && !window.MSStream;
      const isAndroid = /Android/.test(ua);
      const isSafari  = /Safari/.test(ua) && !/Chrome/.test(ua);
      const isStandalone = window.navigator.standalone === true || window.matchMedia("(display-mode: standalone)").matches;

      if(isStandalone) return {
        icon:"✅",
        title:"Already Installed!",
        subtitle:"You're running as a PWA",
        body:"You've already installed Cottage Con to your home screen. You're good to go — tap the app icon to open it directly next time.",
        color:"#4ADE80",
      };
      if(isIOS && isSafari) return {
        icon:"📱",
        title:"Install on iPhone/iPad",
        subtitle:"Add to your Home Screen",
        body:"Tap the Share button (the box with an arrow) at the bottom of Safari, then tap 'Add to Home Screen'. This gives you a full-screen app with push notifications.",
        color:"#60A5FA",
      };
      if(isIOS && !isSafari) return {
        icon:"📱",
        title:"Install on iPhone/iPad",
        subtitle:"Open in Safari first",
        body:"To install Cottage Con, you need to open this page in Safari (not Chrome or another browser). Then tap the Share button → 'Add to Home Screen'.",
        color:"#60A5FA",
      };
      if(isAndroid) return {
        icon:"🤖",
        title:"Install on Android",
        subtitle:"Add to Home Screen",
        body:"Tap the three-dot menu (⋮) in Chrome and select 'Add to Home Screen' or 'Install App'. You'll get a full app icon and push notifications.",
        color:"#4ADE80",
      };
      return {
        icon:"💻",
        title:"Install as an App",
        subtitle:"Desktop & other browsers",
        body:"In Chrome or Edge, look for the install icon (⊕) in the address bar and click it. On other browsers, use the menu to find 'Install' or 'Add to Home Screen'.",
        color:T.amber,
      };
    })(),
  ];

  const current=PAGES[page];
  const isLast=page===PAGES.length-1;

  return (
    <div style={{position:"fixed",inset:0,zIndex:9999,display:"flex",alignItems:"center",justifyContent:"center",
      background:"rgba(0,0,0,.75)",backdropFilter:"blur(6px)",padding:20}}>
      <div style={{background:T.bgMid,border:`3px solid ${current.color}55`,borderRadius:12,
        maxWidth:420,width:"100%",position:"relative",overflowX:"hidden",overflowY:"auto",maxHeight:"calc(100dvh - 40px)",
        boxShadow:`0 0 60px ${current.color}22, 0 24px 48px rgba(0,0,0,.6)`,
        animation:"ccFade .25s ease"}}>

        {/* Top accent bar */}
        <div style={{height:4,background:`linear-gradient(90deg,transparent,${current.color},transparent)`}}/>

        {/* Rivets */}
        <Rivet style={{top:-2,left:-2}}/><Rivet style={{top:-2,right:-2}}/>

        {/* Content */}
        <div style={{padding:"28px 28px 20px"}}>
          {/* Icon */}
          <div style={{textAlign:"center",marginBottom:16}}>
            <div style={{fontSize:52,lineHeight:1,filter:`drop-shadow(0 0 12px ${current.color}88)`,marginBottom:12}}>
              {current.icon}
            </div>
            <h2 style={{fontFamily:"'Cinzel',serif",fontSize:18,color:current.color,fontWeight:700,
              marginBottom:4,letterSpacing:".04em",textShadow:`0 0 20px ${current.color}66`}}>
              {current.title}
            </h2>
            <div style={{fontSize:12,color:T.hint,fontStyle:"italic"}}>{current.subtitle}</div>
          </div>

          {/* Body */}
          <p style={{fontSize:14,color:T.muted,lineHeight:1.7,textAlign:"center",marginBottom:current.note?14:24,minHeight:72}}>
            {current.body}
          </p>

          {/* In-world flavour line */}
          {current.note&&<div style={{marginBottom:22,padding:"10px 14px",borderRadius:6,background:T.bg,
            border:`1px solid ${current.color}33`,borderLeft:`3px solid ${current.color}`}}>
            <div style={{fontSize:9,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase",color:current.color,
              fontFamily:"'Cinzel',serif",marginBottom:4}}>🎭 Field Intelligence</div>
            <div style={{fontSize:12,color:T.muted,fontStyle:"italic",lineHeight:1.6}}>{current.note}</div>
          </div>}

          {/* Page dots */}
          <div style={{display:"flex",justifyContent:"center",gap:6,marginBottom:20}}>
            {PAGES.map((_,i)=>(
              <button key={i} onClick={()=>setPage(i)}
                style={{width:i===page?20:7,height:7,borderRadius:4,border:"none",cursor:"pointer",
                  background:i===page?current.color:T.border2,transition:"all .2s"}}/>
            ))}
          </div>

          {/* Buttons */}
          <div style={{display:"flex",gap:10}}>
            {page>0&&(
              <button onClick={()=>setPage(p=>p-1)}
                style={{flex:1,fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"10px 0",
                  borderRadius:6,border:`2px solid ${T.border2}`,background:"transparent",
                  color:T.muted,cursor:"pointer",transition:"all .15s"}}>
                ← Back
              </button>
            )}
            {!isLast?(
              <button onClick={()=>setPage(p=>p+1)}
                style={{flex:1,fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,padding:"10px 0",
                  borderRadius:6,border:`2px solid ${current.color}`,
                  background:current.color+"22",color:current.color,cursor:"pointer",transition:"all .15s",
                  boxShadow:`0 0 12px ${current.color}33`}}>
                Next →
              </button>
            ):(
              <button onClick={dismiss}
                style={{flex:1,fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,padding:"10px 0",
                  borderRadius:6,border:`2px solid ${current.color}`,
                  background:current.color,color:T.bg,cursor:"pointer",transition:"all .15s",
                  boxShadow:`0 0 16px ${current.color}55`}}>
                ⚓ All Hands Ready!
              </button>
            )}
          </div>

          {/* Skip */}
          {!isLast&&(
            <div style={{textAlign:"center",marginTop:12}}>
              <button onClick={dismiss}
                style={{background:"none",border:"none",fontSize:11,color:T.hint,cursor:"pointer",
                  fontFamily:"'Cinzel',serif",letterSpacing:".04em",textDecoration:"underline"}}>
                Skip tour
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Device / browser detection ────────────────────────────────────────────────
export function getDeviceInfo(){
  const ua = navigator.userAgent;
  // OS
  const os = /iPad|iPhone|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua)   ? "Android"
    : /Win/.test(ua)       ? "Windows"
    : /Mac/.test(ua)       ? "macOS"
    : /Linux/.test(ua)     ? "Linux"
    : "Unknown OS";
  // Browser
  const browser = /Edg\//.test(ua)     ? "Edge"
    : /OPR\/|Opera/.test(ua)  ? "Opera"
    : /Chrome\//.test(ua)     ? "Chrome"
    : /Firefox\//.test(ua)    ? "Firefox"
    : /Safari\//.test(ua)     ? "Safari"
    : "Unknown Browser";
  // Device type
  const mobile = /Mobi|Android|iPhone|iPad/.test(ua);
  const tablet = /iPad|Android(?!.*Mobile)/.test(ua);
  const deviceType = tablet ? "Tablet" : mobile ? "Mobile" : "Desktop";
  return {os, browser, deviceType};
}


// ── Push Notifications ────────────────────────────────────────────────────────
function usePushNotifications(authUser, profile, doUpdateProfile, showToast){
  const showToastRef = useRef(showToast);
  useEffect(()=>{ showToastRef.current = showToast; },[showToast]);
  // `Notification` is undeclared (not just undefined) on iOS Safari outside an installed PWA — guard with typeof
  const [permission, setPermission] = useState(typeof Notification!=="undefined" ? Notification.permission : "default");
  const [supported,  setSupported]  = useState(false);

  useEffect(()=>{
    messagingSupported().then(ok => setSupported(ok));
  },[]);

  // Listen for foreground messages and show a toast-style notification
  useEffect(()=>{
    if(!authUser) return;
    let unsub;
    getMessagingInstance().then(m => {
      if(!m) return;
      unsub = onMessage(m, payload=>{
        console.log("[FCM] Foreground message:", payload);
        const {title, body} = payload.notification || {};
        // Show native notification if permission granted (some browsers suppress in foreground)
        if(Notification.permission==="granted" && title){
          try { new Notification(title, {body, icon:"/icon-192.png", badge:"/icon-72.png"}); }
          catch(e){ console.warn("Native notification failed:", e); }
        }
        // Show rich in-app notification banner for foreground messages
        if(typeof showToastRef.current === "function"){
          const msg = [title, body].filter(Boolean).join(": ");
          showToastRef.current(msg ? `🔔 ${msg}` : "🔔 New notification");
        }
      });
    });
    return ()=>{ if(unsub) unsub(); };
  },[authUser]);

  const requestPermission = async () => {
    if(!supported) return;
    try {
      const m = await getMessagingInstance();
      if(!m){ console.warn("FCM: not supported on this browser"); return; }

      // 1. Request notification permission first
      const perm = await Notification.requestPermission();
      setPermission(perm);
      console.log("FCM: permission →", perm);
      if(perm !== "granted") return;

      // 2. Register the messaging SW and wait until it is fully active
      let swReg;
      try {
        swReg = await navigator.serviceWorker.register(
          "/firebase-messaging-sw.js",
          { scope: "/", updateViaCache: "none" }
        );
        // If a new SW is installing or waiting, force it to activate now
        if(swReg.installing){
          await new Promise(resolve => {
            swReg.installing.addEventListener("statechange", e => {
              if(e.target.state === "activated") resolve();
            });
          });
        } else if(swReg.waiting){
          swReg.waiting.postMessage({type:"SKIP_WAITING"});
          await new Promise(resolve => {
            swReg.addEventListener("updatefound", () => {
              swReg.installing.addEventListener("statechange", e => {
                if(e.target.state === "activated") resolve();
              });
            });
            setTimeout(resolve, 2000); // fallback
          });
        }
        console.log("FCM: messaging SW active:", swReg.active?.state);
      } catch(e) {
        console.error("FCM: SW registration failed:", e);
        // Fall back to any existing registration
        swReg = await navigator.serviceWorker.getRegistration("/firebase-messaging-sw.js");
        if(!swReg) { console.error("FCM: no SW registration found"); return; }
      }

      // 3. Get FCM token — pass the specific SW registration
      const token = await getToken(m, {
        vapidKey: VAPID_KEY,
        serviceWorkerRegistration: swReg,
      });

      console.log("FCM token:", token || "(empty — check VAPID key / SW scope / Firebase Console)");

      // 4. Save token to Firestore
      if(token){
        await doUpdateProfile({...profile, fcmToken: token, fcmTokenUpdated: Date.now()});
        console.log("FCM: token saved to Firestore ✓");
        setPermission("granted");
      } else {
        console.warn("FCM: getToken returned empty token. Check: VAPID key, SW at /firebase-messaging-sw.js, Firebase project config.");
      }
      return token;
    } catch(e){
      console.error("FCM error:", e.code || e.message, e);
    }
  };

  return { permission, supported, requestPermission };
}


// ── BGG lookup ────────────────────────────────────────────────────────────────
// Game IDs come from the BGG ranks index stored in Firestore (bggIndex/current, published from the
// Engine Room → BGG Index tab), NOT from Gemini's memory. Gemini is only asked for the details
// the index doesn't have (player counts, weight, blurb).
let _bggMatcherPromise = null;
export const resetBggMatcher = () => { _bggMatcherPromise = null; };

// Loads the index once per page. Resolves to a matcher, or null when no index is published / readable
// (callers then fall back to the old Gemini-only lookup).
export function getBggMatcher() {
  if(!_bggMatcherPromise){
    _bggMatcherPromise = (async () => {
      try {
        const snap = await getDoc(doc(db, "bggIndex", "current"));
        const rows = snap.exists() ? parseBggIndexDoc(snap.data()) : null;
        return rows ? createBggMatcher(rows) : null;
      } catch(e) {
        console.warn("[BGG index] unavailable:", e?.code || e?.message);
        _bggMatcherPromise = null; // allow a retry on the next lookup
        return null;
      }
    })();
  }
  return _bggMatcherPromise;
}

// Replaces the published index (full overwrite, not a merge) and drops the cached matcher.
export async function saveBggIndex(payload) {
  await setDoc(doc(db, "bggIndex", "current"), payload);
  resetBggMatcher();
}

const BGG_BLANK = { name:"", minPlayers:"", maxPlayers:"", minPlaytime:"", maxPlaytime:"", weight:"", rating:"", year:"", description:"" };

// Asks Gemini for the details the index lacks. Returns null on any failure.
async function fetchBggDetails(title, yearHint) {
  console.log("[BGG via Gemini] Looking up:", title);
  try {
    const res = await fetch(GEMINI_URL, {
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body: JSON.stringify({
        contents:[{ role:"user", parts:[{ text:
          `For the board game "${title}"${yearHint ? ` (${yearHint})` : ""}, provide the following information from BoardGameGeek. Reply ONLY in this exact format with no extra text:
NAME: <official game name>
MINP: <minimum players number>
MAXP: <maximum players number>
TIME: <average playtime in minutes>
WEIGHT: <complexity rating 1-5>
RATING: <BGG average rating>
YEAR: <year published>
BGG_ID: <BGG numeric ID>
DESC: <one sentence description under 150 chars>
If you don't know the BGG ID, put 0.` }]}],
        generationConfig:{ maxOutputTokens:200, temperature:0 },
      }),
    });
    if(!res.ok){
      const errText = await res.text().catch(()=>"");
      console.warn("[BGG] API error:", res.status, errText.slice(0,200));
      return null;
    }
    const data = await res.json();
    // Response may have multiple parts when search grounding is used — concatenate all text
    const parts = data?.candidates?.[0]?.content?.parts || [];
    const text  = parts.map(p=>p.text||"").join("").trim();
    console.log("[BGG via Gemini] Raw response:", text.slice(0,300));

    const get = (key) => text.match(new RegExp(key + ":\\s*(.+)", "i"))?.[1]?.trim() || "";
    const name = get("NAME");
    if(!name) return null;
    const remembered = get("BGG_ID").replace(/\D/g,"");
    return {
      name,
      minPlayers:  get("MINP"),
      maxPlayers:  get("MAXP"),
      minPlaytime: get("TIME"),
      maxPlaytime: get("TIME"),
      weight:      get("WEIGHT"),
      rating:      get("RATING"),
      year:        get("YEAR"),
      description: get("DESC"),
      rememberedId: remembered && remembered !== "0" ? Number(remembered) : null, // the model's recollection — unreliable
    };
  } catch(e) {
    console.warn("[BGG via Gemini] failed:", e.message);
    return null;
  }
}

// lookupBGG(name)        → resolve a name against the index (exact match pins a real BGG id)
// lookupBGG(name, game)  → `game` is a candidate the user picked from the index; skip matching
// Result: the usual detail fields plus { bggUrl, bggId, source: "index"|"search"|"gemini", candidates }.
//   source "index"  : exact index match — bggUrl is the game's real page; name/year/rating come from BGG's data
//   source "search" : index loaded but no exact match — bggUrl is a BGG search link; `candidates` are close titles to offer
//   source "gemini" : no index published — legacy behaviour using the model's remembered id
export async function lookupBGG(gameName, known) {
  if(!gameName?.trim()) return null;
  const cleanedName = gameName
    .replace(/\s+MINP.*$/i,"").replace(/\s+MAXP.*$/i,"")
    .replace(/\s+\d+[-–]\d+.*/i,"").trim();

  const matcher = known ? null : await getBggMatcher();
  const found   = matcher ? matcher.find(cleanedName) : null;
  const ref     = known || (found?.status === "exact" ? found.match : null);

  const details = await fetchBggDetails(ref?.name || cleanedName, ref?.year || "");

  if(ref){
    const { rememberedId, ...rest } = details || {};
    return { ...BGG_BLANK, ...rest, name: ref.name, rating: String(ref.rating || ""), year: String(ref.year || ""),
      bggId: ref.id, bggUrl: bggGameUrl(ref.id), source: "index", candidates: [] };
  }
  if(matcher){ // index loaded, no exact match: never trust the model's remembered id
    const candidates = found.candidates;
    if(!details && !candidates.length) return null;
    const { rememberedId, ...rest } = details || {};
    // keep the user's own spelling — an unconfirmed title shouldn't be silently renamed by the model
    return { ...BGG_BLANK, ...rest, name: cleanedName, bggId: null,
      bggUrl: bggSearchUrl(cleanedName), source: "search", candidates };
  }
  if(!details) return null;
  const { rememberedId, ...rest } = details;
  return { ...rest, bggId: rememberedId, bggUrl: rememberedId ? bggGameUrl(rememberedId) : bggSearchUrl(cleanedName),
    source: "gemini", candidates: [] };
}

// Determine category from BGG weight + player counts
// Rules: 2-player only → "2 Player", maxPlayers > 6 → "Party"
// Weight < 2.2 → "Light", >= 3.5 → "Heavy", 2.2–3.5 → "Medium"
export function detectCategory(weight, minP, maxP) {
  const w   = parseFloat(weight) || 0;
  const min = parseInt(minP)     || 0;
  const max = parseInt(maxP)     || 0;
  if(max === 2 && min <= 2) return "2 Player";
  if(max > 6)               return "Party";
  if(w > 0 && w < 2.2)     return "Light";
  if(w > 0 && w >= 3.5)    return "Heavy";
  if(w > 0)                 return "Medium";
  return "";
}


// ── Image compression — resizes and re-encodes to JPEG before saving ──────────
// Reduces typical phone photos from 3-8 MB down to ~150-300 KB
function compressImage(dataUrl, maxDim = 1200, quality = 0.72) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = reject;
    img.onload = () => {
      const scale   = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w       = Math.round(img.width  * scale);
      const h       = Math.round(img.height * scale);
      const canvas  = document.createElement("canvas");
      canvas.width  = w;
      canvas.height = h;
      canvas.getContext("2d").drawImage(img, 0, 0, w, h);
      const compressed = canvas.toDataURL("image/jpeg", quality);
      const origKB = Math.round(dataUrl.length * 0.75 / 1024);
      const compKB = Math.round(compressed.length * 0.75 / 1024);
      console.log(`[Compress] ${origKB} KB → ${compKB} KB (${w}×${h})`);
      resolve(compressed);
    };
    img.src = dataUrl;
  });
}

// ── Game badge — initials-based coloured badge ─────────────────────────────────
export function gameBadge(name=""){
  // Generate initials: up to 3 capital letters or first chars of words
  const words = name.trim().split(/\s+/).filter(w=>w.length>0);
  let initials;
  if(words.length===1) initials = words[0].slice(0,3).toUpperCase();
  else initials = words.slice(0,3).map(w=>w[0].toUpperCase()).join("");

  // Deterministic colour from name
  const colours=[
    {bg:"#1E3A2F",text:"#4ADE80",border:"#166534"},
    {bg:"#1E2A3A",text:"#60A5FA",border:"#1D4ED8"},
    {bg:"#2A1E3A",text:"#C084FC",border:"#7E22CE"},
    {bg:"#3A2A1E",text:"#FB923C",border:"#9A3412"},
    {bg:"#3A1E2A",text:"#F472B6",border:"#9D174D"},
    {bg:"#2A3A1E",text:"#A3E635",border:"#3F6212"},
    {bg:"#1E3A3A",text:"#22D3EE",border:"#0E7490"},
    {bg:"#3A3A1E",text:"#FBBF24",border:"#92400E"},
  ];
  let hash=0;
  for(let i=0;i<name.length;i++) hash=(hash*31+name.charCodeAt(i))&0xffffffff;
  const c=colours[Math.abs(hash)%colours.length];
  return {initials, ...c};
}

// ── Game name cleaner — strips player counts that bleed into the name ─────────
export const cleanGameName = (raw = "") => raw
  .replace(/\s*[\|:,]\s*\d+\s*[-\u2013to]+\s*\d+\s*(players?)?/gi, "")
  .replace(/\s+\d+\s*[-\u2013]\s*\d+\s*(players?)?/gi, "")
  .replace(/\s+\d+\s+to\s+\d+\s*(players?)?/gi, "")
  .replace(/\s*\(\s*\d+.*?\)/g, "")
  .replace(/\s+for\s+\d+.*/gi, "")
  .replace(/\s*players?:\s*\d+.*/gi, "")
  .replace(/\s+\d+\s+players?/gi, "")
  .replace(/\s+\bfor\b$/i, "")
  .replace(/[\s|:,]+$/, "")
  .trim();


// Fields an admin can change while someone is signed in (tour reset, role, deposit, rank). `profile` is loaded once at
// sign-in, so without this a later profile save would write the old values back over the admin's change.
const LIVE_PROFILE_FIELDS = ["onboarded", "narrativeRole", "deposit", "crewRank"];
export function syncLiveProfileFields(profile, live) {
  if (!profile || !live) return profile;
  const changed = LIVE_PROFILE_FIELDS.filter(k => k in live && !Object.is(live[k], profile[k]));
  return changed.length ? { ...profile, ...Object.fromEntries(changed.map(k => [k, live[k]])) } : profile;
}

// Replays the welcome tour for the given users (on their next sign-in or reload). Reports failures instead of throwing,
// so one rejected write doesn't hide that the others went through.
export async function resetOnboardingForAll(userIds) {
  const results = await Promise.allSettled(userIds.map(id => fsSet("users", id, { onboarded: false })));
  const failed = userIds.filter((_, i) => results[i].status === "rejected");
  return { total: userIds.length, done: userIds.length - failed.length, failed };
}

export default function App(){
  const [authUser, setAuthUser] = useState(undefined);
  const [profile,  setProfile]  = useState(null);
  const [users,    setUsers]    = useState({});
  const [games,    setGames]    = useState({});
  const [food,     setFood]     = useState({});
  const [supplies,  setSupplies]  = useState({});
  const [voyageMenu,setVoyageMenu]=useState({});
  const [deckHands, setDeckHands] = useState({});
  const [receipts,  setReceipts]  = useState({});
  const [itinerary,    setItinerary]    = useState({});
  const [costSettings, setCostSettings] = useState({});
  const [itinMeta,    setItinMeta]    = useState({});
  const [suspectScores, setSuspectScores] = useState({});
  const [missionClaims, setMissionClaims] = useState({});
  const [view,      setView]      = useState("login");
  const [toast,    setToast]    = useState(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const showToast = useCallback(msg=>setToast(msg),[]);

  useEffect(()=>onAuthStateChanged(auth, async user=>{
    setAuthUser(user??null);
    if(user){
      const snap=await getDoc(doc(db,"users",user.uid));
      if(snap.exists()){
        const data=snap.data();
        const device=getDeviceInfo();
        // Write lastLogin + device info on every sign-in (non-blocking)
        const loginUpdate={
          lastLogin:Date.now(),
          lastDevice:device,
          // Append to login history (keep last 10)
          loginHistory:[{ts:Date.now(),...device},...(data.loginHistory||[])].slice(0,10),
        };
        fsSet("users",user.uid,{...data,...loginUpdate});
        setProfile({...data,...loginUpdate});
        setView("dashboard");

      } else setView("setup");
    } else { setProfile(null); setView("login"); }
  }),[]);

  useEffect(()=>{
    if(!authUser) return;
    let notifHistoryLoaded=false;
    const subs=[
      subCol("users",      setUsers),
      subCol("games",      setGames),
      subCol("food",       setFood),
      subCol("supplies",   setSupplies),
      subCol("voyageMenu", setVoyageMenu),
      subCol("deckHands",  setDeckHands),
      subCol("receipts",   setReceipts),
      subCol("itinerary",  setItinerary),
      subCol("suspectScores", setSuspectScores),
      subCol("missionClaims", setMissionClaims),
      subCol("settings",   d=>{setCostSettings(d?.costCalc||{});setItinMeta(d?.itinMeta||{});}),
      onSnapshot(collection(db,"notifications"), s=>{
        // Listen for new notifications and show in-app toast for current user.
        // The first snapshot is the existing history — only toast for notifications that arrive afterwards.
        if(!notifHistoryLoaded){ notifHistoryLoaded=true; return; }
        s.docChanges().forEach(change=>{
          if(change.type==="added"){
            const n=change.doc.data();
            // Don't show toast to the sender (they already see the queue toast)
            if(n.sentBy!==authUser?.uid && n.title){
              // Small delay so auth state is stable
              setTimeout(()=>setToast(`🔔 ${n.title}${n.body?": "+n.body:""}`),500);
            }
          }
        });
      }),
    ];
    return()=>subs.forEach(u=>u());
  },[authUser]);

  useEffect(()=>{
    setProfile(p=>syncLiveProfileFields(p, users[authUser?.uid]));
  },[users, authUser?.uid]);

  const doRegister=async(email,pw,name,dietary,picture)=>{
    const cred=await createUserWithEmailAndPassword(auth,email,pw);
    await updateProfile(cred.user,{displayName:name});
    const prof={id:cred.user.uid,name,email,dietary,picture:picture||"",crewRank:"Enlisted",createdAt:Date.now(),onboarded:false};
    await setDoc(doc(db,"users",cred.user.uid),prof);
    setProfile(prof); setView("dashboard");
    showToast(`All aboard, ${name.split(" ")[0]}! ⚙️`);
  };
  const doLogin  = (email,pw)=>signInWithEmailAndPassword(auth,email,pw);
  const doLogout = async()=>{ await signOut(auth); setView("login"); };
  const doUpdateProfile = async u=>{ await fsSet("users",authUser.uid,u); setProfile(u); showToast("Captain's log updated! ⚙️"); };
  const doLogGamePlayed = async (uid, gameName) => {
    const u = users[uid]||{};
    const played = u.gamesPlayed||[];
    if(played.includes(gameName)) return; // no dupes
    await fsSet("users", uid, {...u, gamesPlayed:[...played, gameName]});
  };
  const doRemoveGamePlayed = async (uid, gameName) => {
    const u = users[uid]||{};
    const played = (u.gamesPlayed||[]).filter(g=>g!==gameName);
    await fsSet("users", uid, {...u, gamesPlayed:played});
  };
  const {permission:notifPerm, supported:notifSupported, requestPermission} = usePushNotifications(authUser, profile, doUpdateProfile, showToast);
  const doSaveGame   = g=>fsSet("games",g.id,g);
  const doDelGame    = async id=>{ await fsDel("games",id); showToast("Game removed from chest."); };
  const doToggleLike = async gameId=>{
    const g=games[gameId]; if(!g) return;
    const likes=g.likes||[];
    await fsSet("games",gameId,{...g,likes:likes.includes(authUser.uid)?likes.filter(x=>x!==authUser.uid):[...likes,authUser.uid]});
  };
  const doSaveFood   = item=>fsSet("food",item.id,item);
  const doDelFood    = async id=>{ await fsDel("food",id); showToast("Removed."); };
  const doSaveSupply = item=>fsSet("supplies",item.id,item);
  const doDelSupply  = async id=>{ await fsDel("supplies",id); showToast("Removed."); };

  const doSaveItinDay  = item => fsSet("itinerary", item.id, item);
  const doDelItinDay   = async id => { await fsDel("itinerary", id); showToast("Day removed."); };
  const doSaveDeckSlot = item => fsSet("deckHands", item.id, item);
  const doDelDeckSlot  = async id => { await fsDel("deckHands", id); showToast("Slot removed."); };
  // Manifest / receipts
  const doSaveReceipt = item => fsSet("receipts", item.id, item);
  const doDelReceipt  = async id => { await fsDel("receipts", id); showToast("Receipt removed."); };

  // Voyage menu actions
  const doSaveMenuItem = item => fsSet("voyageMenu", item.id, item);
  const doDelMenuItem  = async id => { await fsDel("voyageMenu", id); showToast("Menu item removed."); };

  // Deck hands actions
  const doClaimSlot = async (slotId, claimUid, name) => {
    const slot = deckHands[slotId]; if (!slot) return;
    await fsSet("deckHands", slotId, { ...slot, claimedBy: claimUid, claimedByName: name });
  };
  const doUnclaimSlot = async slotId => {
    const slot = deckHands[slotId]; if (!slot) return;
    await fsSet("deckHands", slotId, { ...slot, claimedBy: null, claimedByName: "" });
  };
  const doInitDeckHands = async () => {
    const DAYS  = ["Nov 26","Nov 27","Nov 28","Nov 29"];
    const PREP  = ["Grocery run","Unpack & set up","Table & game setup","Activity prep","Welcome drinks setup"];
    const CLEAN = ["Dishes & kitchen","Common area tidy","Trash & recycling","Bathroom check","Final sweep"];
    const batch = [];
    DAYS.forEach(day => {
      PREP.forEach((task, i) => {
        const id = `prep_${day.replace(" ","")}${i}`;
        if (!deckHands[id]) batch.push(fsSet("deckHands", id, { id, day, type:"prep",    task, claimedBy:null, claimedByName:"" }));
      });
      CLEAN.forEach((task, i) => {
        const id = `clean_${day.replace(" ","")}${i}`;
        if (!deckHands[id]) batch.push(fsSet("deckHands", id, { id, day, type:"cleanup", task, claimedBy:null, claimedByName:"" }));
      });
    });
    await Promise.all(batch);
  };

  // Send FCM notification via Firestore trigger + client fan-out
  const doSendNotification = async ({title, body, targetTokens, targetAll}) => {
    const allTokens = targetAll
      ? Object.values(users).map(u=>u.fcmToken).filter(Boolean)
      : targetTokens || [];

    if(!allTokens.length){
      showToast("⚠️ No registered devices found.");
      return { sent: 0 };
    }

    // Write to Firestore so Cloud Functions can pick it up for server-side delivery
    const notifId = uid();
    await fsSet("notifications", notifId, {
      id: notifId,
      title,
      body,
      tokens: allTokens,
      sentBy: authUser.uid,
      sentByName: profile?.name || "Engine Room",
      createdAt: Date.now(),
      status: "pending",
    });

    showToast(`📨 Notification queued for ${allTokens.length} device${allTokens.length!==1?"s":""}!`);
    return { sent: allTokens.length, notifId };
  };

  // Itinerary meta (check-in / check-out) — persisted to Firestore
  const doSaveItinMeta = async (vals) => {
    await fsSet("settings","itinMeta",vals);
  };

  // Cost Calculator settings — persisted to Firestore
  const doSaveCostSettings = async (vals) => {
    await fsSet("settings","costCalc",vals);
  };

  // Deposit flag — engine room only, read-only for users
  const doSetDeposit = async (userId, value) => {
    const userDoc = users[userId];
    if(!userDoc) return;
    await fsSet("users", userId, {...userDoc, deposit: value});
    showToast(value ? "💰 Deposit marked received!" : "Deposit cleared.");
  };

  // Adds one suspect-board check to the shared leaderboard (suspectScores/<uid>)
  const doRecordSuspectCheck = async (result) => {
    if(!authUser) return;
    try{ await recordSuspectCheck(authUser.uid, suspectScores[authUser.uid], result); }
    catch(e){ console.error("[suspectScores] save failed:", e); showToast("⚠️ Couldn't save your score. Check your connection and try again."); }
  };

  // Sends a win-condition claim with its proof photo for the organiser to review
  const doSubmitMissionClaim = async ({picks, note, photo}) => {
    try{
      await submitMissionClaim({claimantId:authUser.uid, roleKey:users[authUser.uid]?.narrativeRole||profile?.narrativeRole, picks, note, photo, users, claims:missionClaims});
      showToast("📸 Claim sent for review!");
      return true;
    }catch(e){ showToast(`⚠️ ${e.message||"Couldn't send your claim."}`); return false; }
  };

  // Engine Room: approve or reject a claim
  const doReviewMissionClaim = async (claim, decision, note, uncounted) => {
    try{
      await reviewMissionClaim({claim, decision, note, reviewerId:authUser.uid, users, uncounted});
      showToast(decision==="approved"?"✓ Claim approved":"Claim rejected");
      return true;
    }catch(e){ showToast(`⚠️ ${e.message||"Couldn't save that decision."}`); return false; }
  };

  // Engine Room: give a player back the attempt a rejected claim used
  const doForgiveClaimAttempt = async (claim) => {
    try{ await forgiveClaimAttempt(claim); showToast("Attempt given back."); return true; }
    catch(e){ showToast(`⚠️ ${e.message||"Couldn't give that attempt back."}`); return false; }
  };

  // Engine Room: replay the welcome tour for everyone
  const doResetOnboarding = async () => {
    const result = await resetOnboardingForAll(Object.keys(users));
    showToast(result.failed.length
      ? `⚠️ Reset ${result.done} of ${result.total} crew. Try again for the rest.`
      : `Welcome tour reset for ${result.done} crew.`);
    return result;
  };

  // Narrative role assignment — engine room only (quiet skips the toast, for bulk assignment)
  const doAssignNarrativeRole = async (userId, roleKey, quiet=false) => {
    if(!users[userId]) return;
    await fsSet("users", userId, {narrativeRole: roleKey || null});
    if(!quiet) showToast(roleKey ? "Role assigned!" : "Role cleared.");
  };

  // Crew rank — engine room override (users can also set their own in Personal Log)
  const doSetRank = async (userId, rank) => {
    const userDoc = users[userId];
    if(!userDoc) return;
    await fsSet("users", userId, {...userDoc, crewRank: rank});
    showToast(`Rank updated to ${rank}!`);
  };

  if(authUser===undefined) return <><SteampunkBg/><Spinner label="Firing up the engines…"/></>;

  const ctx={authUser,profile,users,games,food,supplies,voyageMenu,deckHands,receipts,itinerary,view,setView,showToast,menuOpen,setMenuOpen,
    doLogin,doLogout,doRegister,doUpdateProfile,doLogGamePlayed,doRemoveGamePlayed,
    doSaveGame,doDelGame,doToggleLike,
    doSaveFood,doDelFood,doSaveSupply,doDelSupply,
    doSaveMenuItem,doDelMenuItem,doClaimSlot,doUnclaimSlot,doInitDeckHands,
    doSaveReceipt,doDelReceipt,
    doSaveItinDay,doDelItinDay,doSaveDeckSlot,doDelDeckSlot,doSetDeposit,doSetRank,doSendNotification,doSaveCostSettings,costSettings,doSaveItinMeta,itinMeta,doAssignNarrativeRole,suspectScores,doRecordSuspectCheck,missionClaims,doSubmitMissionClaim,doReviewMissionClaim,doForgiveClaimAttempt,doResetOnboarding,
    notifPerm,notifSupported,requestPermission};

  return <>
    <SteampunkBg/>
    {!authUser&&(view==="login"||view==="register")&&<AuthScreen ctx={ctx} mode={view}/>}
    {authUser&&view==="verify-email"&&<VerifyEmailScreen ctx={ctx}/>}
    {authUser&&view==="setup"&&<SetupScreen ctx={ctx}/>}
    {authUser&&profile&&!["login","register","setup","verify-email"].includes(view)&&<Shell ctx={ctx}/>}
    {toast&&<Toast msg={toast} onDone={()=>setToast(null)}/>}
  </>;
}

// ── Auth Screen ───────────────────────────────────────────────────────────────
// ── Email Verification Screen ─────────────────────────────────────────────────
function VerifyEmailScreen({ctx}){
  const {authUser,doLogout}=ctx;
  const [resending,setResending]=useState(false);
  const [resent,setResent]=useState(false);
  const [checking,setChecking]=useState(false);

  const resend=async()=>{
    setResending(true); setResent(false);
    try{
      await sendEmailVerification(authUser,{url:window.location.origin,handleCodeInApp:false});
      setResent(true);
    }catch(e){ console.warn("Resend error:",e); }
    setResending(false);
  };

  const checkVerified=async()=>{
    setChecking(true);
    await authUser.reload();
    if(authUser.emailVerified){
      // Reload the page — onAuthStateChanged will pick up the verified state
      window.location.reload();
    } else {
      setChecking(false);
    }
  };

  return <div style={{minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",padding:20,position:"relative",zIndex:1}}>
    <div className="cc-fade" style={{width:"100%",maxWidth:420,textAlign:"center"}}>
      <GearLogo size={64}/>
      <h1 style={{fontFamily:"'Cinzel',serif",fontSize:22,color:T.amber,margin:"16px 0 8px",letterSpacing:".06em"}}>Cottage Con</h1>
      <Card style={{background:T.bgMid,border:`2px solid ${T.border2}`,marginTop:24}}>
        <div style={{fontSize:56,marginBottom:12}}>📧</div>
        <h2 style={{fontFamily:"'Cinzel',serif",fontSize:16,color:T.amber,marginBottom:8}}>Verify Your Email</h2>
        <p style={{fontSize:13,color:T.muted,lineHeight:1.7,marginBottom:20}}>
          A verification link was sent to <br/>
          <strong style={{color:T.text}}>{authUser?.email}</strong>
          <br/><br/>
          Click the link in that email, then come back here and tap "I've Verified" to board the ship.
        </p>
        <div style={{display:"flex",flexDirection:"column",gap:10}}>
          <Btn onClick={checkVerified} disabled={checking} style={{width:"100%",fontSize:14}}>
            {checking?"Checking…":"⚓ I've Verified — Let Me In"}
          </Btn>
          {!resent
            ?<Btn variant="ghost" onClick={resend} disabled={resending} style={{width:"100%",fontSize:12}}>
                {resending?"Sending…":"📬 Resend verification email"}
              </Btn>
            :<div style={{fontSize:12,color:"#4ADE80",padding:"8px",background:"#162A1E",borderRadius:6,border:"1px solid #166534"}}>
                ✓ Email resent — check your inbox
              </div>
          }
          <button onClick={doLogout}
            style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:T.hint,fontFamily:"'Cinzel',serif",textDecoration:"underline",marginTop:4}}>
            Sign out and use a different account
          </button>
        </div>
      </Card>
    </div>
  </div>;
}


function AuthScreen({ctx,mode}){
  const [email,setEmail]=useState(""); const [pw,setPw]=useState("");
  const [name,setName]=useState(""); const [diet,setDiet]=useState([]);
  const [err,setErr]=useState(""); const [loading,setLoading]=useState(false);
  const [resetMode,setResetMode]=useState(false);
  const [resetSent,setResetSent]=useState(false);
  const {pickImage,imgErr,Input:ImgInput}=useImageUpload();
  const [pic,setPic]=useState("");
  const isReg=mode==="register";

  const errMsg=code=>({
    "auth/email-already-in-use":"That email is already registered. Try signing in.",
    "auth/wrong-password":"Incorrect password. Use 'Forgot password?' to reset.",
    "auth/user-not-found":"No account with that email.",
    "auth/invalid-email":"Invalid email address.",
    "auth/weak-password":"Password must be at least 6 characters.",
    "auth/invalid-credential":"Invalid email or password.",
    "auth/too-many-requests":"Too many attempts. Try again later or reset your password.",
  })[code]||"Something went wrong. Try again.";

  const submit=async()=>{
    setErr(""); setLoading(true);
    try{
      if(isReg){
        if(!name.trim()){setErr("Please enter your name.");setLoading(false);return;}
        await ctx.doRegister(email.trim(),pw,name.trim(),diet,pic);
      } else {
        await ctx.doLogin(email.trim(),pw);
      }
    }catch(e){setErr(errMsg(e.code));}
    setLoading(false);
  };

  const sendReset=async()=>{
    if(!email.trim()){setErr("Enter your email address first.");return;}
    setErr(""); setLoading(true);
    try{
      await sendPasswordResetEmail(auth, email.trim(), { url: window.location.origin });
      setResetSent(true);
    }catch(e){setErr(errMsg(e.code));}
    setLoading(false);
  };

  return <div style={{minHeight:"100dvh",display:"flex",alignItems:"center",justifyContent:"center",paddingTop:`max(16px, env(safe-area-inset-top, 0px))`,paddingBottom:`max(16px, env(safe-area-inset-bottom, 0px))`,paddingLeft:16,paddingRight:16,position:"relative",zIndex:1}}>
    <div className="cc-fade" style={{width:"100%",maxWidth:420}}>
      <div style={{textAlign:"center",marginBottom:24}}>
        <GearLogo size={64}/>
        <h1 style={{fontFamily:"'Cinzel',serif",fontSize:"clamp(22px,5vw,28px)",color:T.amber,margin:"12px 0 4px",letterSpacing:".06em",textShadow:`0 0 20px ${T.amber}66`}}>Cottage Con</h1>
        <p style={{fontSize:13,color:T.muted,fontStyle:"italic"}}>"All hands on deck — bring your games"</p>
      </div>
      <Card style={{boxShadow:`0 8px 48px rgba(0,0,0,.6),0 0 40px ${T.amber}11`,background:T.bgMid,border:`1px solid ${T.border2}`}}>

        {/* Password reset sent confirmation */}
        {resetSent ? (
          <div style={{textAlign:"center",padding:"8px 0"}}>
            <div style={{fontSize:48,marginBottom:12}}>📬</div>
            <h3 style={{fontFamily:"'Cinzel',serif",fontSize:15,color:T.amber,marginBottom:8}}>Reset Email Sent</h3>
            <p style={{fontSize:13,color:T.muted,lineHeight:1.6,marginBottom:16}}>
              Check your inbox at <strong style={{color:T.text}}>{email}</strong> for a password reset link. Check your spam folder if it doesn't arrive within a minute.
            </p>
            <Btn variant="ghost" onClick={()=>{setResetSent(false);setResetMode(false);}} style={{width:"100%"}}>
              ← Back to Sign In
            </Btn>
          </div>
        ) : resetMode ? (
          /* Password reset form */
          <div>
            <div style={{textAlign:"center",marginBottom:20}}>
              <div style={{fontSize:36,marginBottom:8}}>🔑</div>
              <h3 style={{fontFamily:"'Cinzel',serif",fontSize:15,color:T.amber,marginBottom:4}}>Reset Password</h3>
              <p style={{fontSize:12,color:T.muted}}>Enter your email and we'll send a reset link.</p>
            </div>
            <div style={{display:"flex",flexDirection:"column",gap:13}}>
              <Inp label="Email address" type="email" placeholder="captain@airship.com"
                value={email} onChange={e=>setEmail(e.target.value)}
                onKeyDown={e=>e.key==="Enter"&&sendReset()}/>
              {err&&<div style={{fontSize:13,color:T.danger,background:T.dangerBg,padding:"8px 12px",borderRadius:6,border:`1px solid ${T.danger}44`}}>{err}</div>}
              <BrassRule/>
              <Btn onClick={sendReset} disabled={loading} style={{width:"100%"}}>
                {loading?"Sending…":"📬 Send Reset Link"}
              </Btn>
              <Btn variant="ghost" onClick={()=>{setResetMode(false);setErr("");}} style={{width:"100%",fontSize:12}}>
                ← Back to Sign In
              </Btn>
            </div>
          </div>
        ) : (
          /* Normal login / register form */
          <>
            <div style={{display:"flex",background:T.bg,borderRadius:6,padding:3,marginBottom:20}}>
              {[["login","Sign In"],["register","Enlist"]].map(([v,l])=>(
                <button key={v} onClick={()=>{ctx.setView(v);setErr("");setResetMode(false);}}
                  style={{flex:1,fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,padding:"8px 0",borderRadius:5,border:"none",cursor:"pointer",transition:"all .15s",background:mode===v?T.amber:"transparent",color:mode===v?T.bg:T.muted,letterSpacing:".04em"}}>
                  {l}
                </button>
              ))}
            </div>

            {/* Registration note */}
            {isReg&&<div style={{background:T.surface2,border:`1px solid ${T.border}`,borderRadius:6,padding:"10px 12px",marginBottom:4,display:"flex",gap:8,alignItems:"flex-start"}}>
              <span style={{fontSize:16,flexShrink:0}}>📧</span>
              <div style={{fontSize:12,color:T.muted,lineHeight:1.5}}>
                A verification email will be sent to your address. You'll need to confirm it before boarding.
              </div>
            </div>}

            <div style={{display:"flex",flexDirection:"column",gap:13}}>
              {isReg&&<>
                <div style={{textAlign:"center"}}>
                  <ImgInput/>
                  <div onClick={()=>pickImage(setPic)}
                    style={{width:76,height:76,borderRadius:"50%",background:pic?`url(${pic}) center/cover`:T.surface2,margin:"0 auto 6px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,border:`2px dashed ${T.amber}`,overflow:"hidden"}}>
                    {!pic&&"🧑"}
                  </div>
                  <div style={{fontSize:11,color:T.hint}}>Click to add portrait (max 800 KB)</div>
                  {imgErr&&<div style={{fontSize:12,color:T.danger,marginTop:4,padding:"6px 10px",background:T.dangerBg,borderRadius:5,lineHeight:1.4}}>{imgErr}</div>}
                </div>
                <Inp label="Your name" placeholder="e.g. Captain Jamie" value={name} onChange={e=>setName(e.target.value)}/>
              </>}
              <Inp label="Email" type="email" placeholder="captain@airship.com" value={email} onChange={e=>setEmail(e.target.value)}/>
              <Inp label="Password" type="password" placeholder={isReg?"At least 6 characters":"••••••••"} value={pw} onChange={e=>setPw(e.target.value)} onKeyDown={e=>e.key==="Enter"&&submit()}/>
              {isReg&&<div>
                <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:8}}>Dietary restrictions</span>
                <DietPills selected={diet} onToggle={d=>setDiet(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d])}/>
              </div>}
              {err&&<div style={{fontSize:13,color:T.danger,background:T.dangerBg,padding:"8px 12px",borderRadius:6,border:`1px solid ${T.danger}44`}}>{err}</div>}
              <BrassRule/>
              <Btn onClick={submit} disabled={loading} style={{width:"100%",marginTop:2,fontSize:14}}>
                {loading?"One moment…":isReg?"⚙️ Enlist":"⚓ Board the Ship"}
              </Btn>
              {/* Forgot password — login mode only */}
              {!isReg&&<button onClick={()=>{setResetMode(true);setErr("");}}
                style={{background:"none",border:"none",cursor:"pointer",fontSize:12,color:T.hint,fontFamily:"'Cinzel',serif",letterSpacing:".04em",textDecoration:"underline",marginTop:-4}}>
                Forgot password?
              </button>}
            </div>
          </>
        )}
      </Card>
    </div>
  </div>;
}

// ── Setup Screen ──────────────────────────────────────────────────────────────
function SetupScreen({ctx}){
  const [name,setName]=useState(ctx.authUser?.displayName||"");
  const [diet,setDiet]=useState([]); const [pic,setPic]=useState("");
  const [loading,setLoading]=useState(false);
  const {pickImage,imgErr,Input:ImgInput}=useImageUpload();
  const save=async()=>{if(!name.trim())return;setLoading(true);await ctx.doRegister(ctx.authUser.email,"",name.trim(),diet,pic);setLoading(false);};
  return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",padding:16,position:"relative",zIndex:1}}>
    <div className="cc-fade" style={{width:"100%",maxWidth:400}}>
      <div style={{textAlign:"center",marginBottom:22}}><GearLogo size={52}/><h2 style={{fontFamily:"'Cinzel',serif",color:T.amber,margin:"10px 0 4px"}}>Set Up Your Profile</h2></div>
      <Card style={{background:T.bgMid,border:`1px solid ${T.border2}`}}>
        <div style={{display:"flex",flexDirection:"column",gap:14}}>
          <div style={{textAlign:"center"}}>
            <ImgInput/>
            <div onClick={()=>pickImage(setPic)}
              style={{width:76,height:76,borderRadius:"50%",background:pic?`url(${pic}) center/cover`:T.surface2,margin:"0 auto 6px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",fontSize:28,border:`2px dashed ${T.amber}`,overflow:"hidden"}}>
              {!pic&&"🧑"}
            </div>
            {imgErr&&<div style={{fontSize:12,color:T.danger,marginTop:4,padding:"6px 10px",background:T.dangerBg,borderRadius:5,lineHeight:1.4}}>{imgErr}</div>}
          </div>
          <Inp label="Your name" value={name} onChange={e=>setName(e.target.value)}/>
          <div><span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:8}}>Dietary restrictions</span>
            <DietPills selected={diet} onToggle={d=>setDiet(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d])}/>
          </div>
          <Btn onClick={save} disabled={loading||!name.trim()} style={{width:"100%"}}>{loading?"Saving…":"⚙️ Set Sail"}</Btn>
        </div>
      </Card>
    </div>
  </div>;
}

// ── Shell ─────────────────────────────────────────────────────────────────────
const TABS=[
  {id:"dashboard",  label:"Bridge",       icon:"ti-layout-dashboard"},
  {id:"itinerary",  label:"Itinerary",    icon:"ti-map-2"},
  {id:"games",      label:"Cargo Hold",   icon:"ti-box-multiple"},
  {id:"potluck",    label:"Galley",       icon:"ti-tools-kitchen"},
  {id:"deckhands",  label:"Deck Hands",   icon:"ti-bucket"},
  {id:"manifest",   label:"Manifest",     icon:"ti-receipt"},
  {id:"engineroom", label:"Engine Room",  icon:"ti-settings-cog"},
  {id:"profile",    label:"Personal Log", icon:"ti-user"},
];

function Shell({ctx}){
  const {profile,view,setView,doLogout,menuOpen,setMenuOpen}=ctx;
  const navBg="rgba(17,24,39,0.96)";
  return <div style={{minHeight:"100vh",display:"flex",flexDirection:"column",position:"relative",zIndex:1}}>
    <nav style={{background:navBg,backdropFilter:"blur(12px)",borderBottom:`1.5px solid ${T.border2}`,position:"sticky",top:0,zIndex:100,paddingTop:"env(safe-area-inset-top, 0px)",paddingLeft:16,paddingRight:16,paddingBottom:0,boxShadow:`0 2px 20px rgba(0,0,0,.5),0 1px 0 ${T.amber}22`}}>
      <div style={{maxWidth:960,margin:"0 auto",height:56,display:"flex",alignItems:"center",gap:6}}>
        <button onClick={()=>setView("dashboard")} title="Return to Bridge" style={{display:"flex",alignItems:"center",gap:8,marginRight:"auto",background:"none",border:"none",cursor:"pointer",padding:"4px 8px",borderRadius:6,transition:"background .15s"}} onMouseEnter={e=>e.currentTarget.style.background=T.amberSoft} onMouseLeave={e=>e.currentTarget.style.background="none"}>
          <GearLogo size={28}/>
          <span style={{fontFamily:"'Cinzel',serif",fontSize:15,color:T.amber,fontWeight:700,letterSpacing:".06em",textShadow:`0 0 10px ${T.amber}55`}}>Cottage Con</span>
          <span style={{fontSize:10,color:T.steam,background:T.steamSoft,padding:"2px 7px",borderRadius:4,fontWeight:500,border:`1px solid ${T.steam}44`,display:"none"}} className="cc-live">⚙ live</span>
        </button>
        {/* Desktop tabs */}
        <div className="cc-desktop-tabs" style={{gap:2}}>
          {TABS.map(t=><button key={t.id} onClick={()=>setView(t.id)}
            style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"6px 11px",borderRadius:5,border:"none",cursor:"pointer",transition:"all .15s",background:view===t.id?T.amber:"transparent",color:view===t.id?T.bg:T.muted,letterSpacing:".04em",alignItems:"center",gap:4,boxShadow:view===t.id?`0 0 10px ${T.amber}44`:"none"}}>
            <i className={`ti ${t.icon}`} style={{fontSize:13}}/>{t.label}
          </button>)}
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6}}>
          <button onClick={()=>setView("profile")} title="Personal Log" className="cc-desktop-tabs" style={{background:"none",border:"none",cursor:"pointer",padding:2,borderRadius:"50%",transition:"box-shadow .15s"}} onMouseEnter={e=>e.currentTarget.style.boxShadow=`0 0 14px ${T.amber}99`} onMouseLeave={e=>e.currentTarget.style.boxShadow="none"}><Avatar name={profile?.name} picture={profile?.picture} size={32}/></button>
          <button onClick={doLogout} title="Disembark"
            className="cc-desktop-tabs"
            style={{background:"none",border:"none",cursor:"pointer",color:T.muted,alignItems:"center",padding:"4px 6px",borderRadius:5}}>
            <i className="ti ti-logout" style={{fontSize:15}}/>
          </button>
          {/* Mobile: avatar + hamburger */}
          <button onClick={()=>setView("profile")} title="Personal Log" className="cc-hamburger" style={{background:"none",border:"none",cursor:"pointer",padding:2,borderRadius:"50%"}}>
            <Avatar name={profile?.name} picture={profile?.picture} size={32}/>
          </button>
          <button onClick={()=>setMenuOpen(!menuOpen)} className="cc-hamburger"
            style={{background:"none",border:"none",cursor:"pointer",color:T.amber,fontSize:22,padding:"6px",lineHeight:1,width:36,height:36,alignItems:"center",justifyContent:"center"}}>
            <i className={`ti ${menuOpen?"ti-x":"ti-menu-2"}`}/>
          </button>
        </div>
      </div>
    </nav>

    {/* Mobile menu */}
    {menuOpen&&<div style={{position:"fixed",top:"calc(56px + env(safe-area-inset-top, 0px))",left:0,right:0,background:"rgba(17,24,39,0.98)",backdropFilter:"blur(12px)",zIndex:99,borderBottom:`1.5px solid ${T.border2}`,padding:"10px 16px 16px"}}>
      {TABS.map(t=><button key={t.id} onClick={()=>{setView(t.id);setMenuOpen(false);}}
        style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"12px 14px",borderRadius:6,border:`1px solid ${view===t.id?T.amber:T.border}`,cursor:"pointer",background:view===t.id?T.amberSoft:"transparent",color:view===t.id?T.amber:T.text,fontFamily:"'Cinzel',serif",fontSize:14,fontWeight:700,marginBottom:6,transition:"all .15s"}}>
        <i className={`ti ${t.icon}`} style={{fontSize:18,color:view===t.id?T.amber:T.muted}}/>{t.label}
      </button>)}
      <div style={{borderTop:`1px solid ${T.border}`,marginTop:8,paddingTop:10}}>
        <button onClick={()=>{doLogout();setMenuOpen(false);}}
          style={{width:"100%",display:"flex",alignItems:"center",gap:10,padding:"10px 14px",borderRadius:6,border:"none",cursor:"pointer",background:"transparent",color:T.muted,fontFamily:"inherit",fontSize:14}}>
          <i className="ti ti-logout" style={{fontSize:16}}/>Disembark
        </button>
      </div>
    </div>}

    <OnboardingModal ctx={ctx}/>
    <CrewAssistant ctx={ctx}/>
    <main style={{flex:1,maxWidth:960,margin:"0 auto",width:"100%",padding:"24px 16px"}}>
      {view==="dashboard"  &&<Dashboard ctx={ctx}/>}
      {view==="itinerary"  &&<Itinerary ctx={ctx}/>}
      {view==="games"      &&<GameChest ctx={ctx}/>}
      {view==="potluck"    &&<Provisions ctx={ctx}/>}
      {view==="deckhands"  &&<DeckHands ctx={ctx}/>}
      {view==="manifest"   &&<Manifest ctx={ctx}/>}
      {view==="engineroom" &&<EngineRoom ctx={ctx}/>}
      {view==="profile"    &&<CaptainsLog ctx={ctx}/>}
    </main>

    <footer style={{textAlign:"center",paddingTop:12,paddingBottom:`max(16px, calc(env(safe-area-inset-bottom, 0px) + 12px))`,paddingLeft:`max(16px, env(safe-area-inset-left, 0px))`,paddingRight:`max(16px, env(safe-area-inset-right, 0px))`,borderTop:`1px solid ${T.border}`,color:T.hint,fontSize:11,fontFamily:"'Cinzel',serif",letterSpacing:".05em",background:T.bg}}>
      ⚙ Cottage Con · Steampunk Edition · All Systems Pressurised
    </footer>
  </div>;
}


// ── Countdown Timer ───────────────────────────────────────────────────────────
const DEPARTURE_TIME = new Date("2026-11-26T15:00:00").getTime(); // Nov 26 3 PM local

function useCountdown(){
  const calc = () => {
    const diff = DEPARTURE_TIME - Date.now();
    if(diff <= 0) return null;
    const days    = Math.floor(diff / 86400000);
    const hours   = Math.floor((diff % 86400000) / 3600000);
    const minutes = Math.floor((diff % 3600000)  / 60000);
    const seconds = Math.floor((diff % 60000)    / 1000);
    return {days, hours, minutes, seconds, diff};
  };
  const [time, setTime] = useState(calc);
  useEffect(()=>{
    const id = setInterval(()=>setTime(calc()), 1000);
    return ()=>clearInterval(id);
  },[]);
  return time;
}

function CountdownTimer(){
  const time = useCountdown();

  if(!time) return (
    <div style={{background:T.bgMid,border:`3px solid ${T.amber}`,borderRadius:8,padding:"18px 20px",
      marginBottom:22,textAlign:"center",position:"relative",
      backgroundImage:`linear-gradient(135deg,${T.surface} 0%,${T.surface2} 100%)`,
      boxShadow:`0 0 30px ${T.amber}44, inset 0 1px 0 ${T.borderGlow}44`}}>
      <Rivet style={{top:-2,left:-2}}/><Rivet style={{top:-2,right:-2}}/>
      <Rivet style={{bottom:-2,left:-2}}/><Rivet style={{bottom:-2,right:-2}}/>
      <div style={{fontSize:32,marginBottom:6}}>⚓</div>
      <div style={{fontFamily:"'Cinzel',serif",fontSize:18,color:T.amber,fontWeight:700,letterSpacing:".06em"}}>All hands on deck!</div>
      <div style={{fontSize:13,color:T.muted,marginTop:4}}>Cottage Con has begun — report to Yellow Cottage!</div>
    </div>
  );

  const pads = n => String(n).padStart(2,"0");
  const units = [
    {label:"DAYS",    val:time.days,    color:"#50C8FF", glow:"#50C8FF"},
    {label:"HOURS",   val:time.hours,   color:"#FFD060", glow:"#FFD060"},
    {label:"MINUTES", val:time.minutes, color:"#FF9040", glow:"#FF9040"},
    {label:"SECONDS", val:time.seconds, color:"#FF6070", glow:"#FF6070"},
  ];

  return (
    <div style={{background:T.bgMid,border:`3px solid ${T.border2}`,borderRadius:8,padding:"18px 20px",
      marginBottom:22,position:"relative",
      backgroundImage:`linear-gradient(135deg,${T.surface} 0%,${T.surface2} 100%)`,
      boxShadow:`inset 0 1px 0 ${T.borderGlow}44, 0 4px 16px rgba(0,0,0,.5)`}}>
      <Rivet style={{top:-2,left:-2}}/><Rivet style={{top:-2,right:-2}}/>
      <Rivet style={{bottom:-2,left:-2}}/><Rivet style={{bottom:-2,right:-2}}/>

      {/* Header */}
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
        <div style={{height:2,width:20,background:`linear-gradient(90deg,${T.amber},transparent)`}}/>
        <span style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber,fontWeight:700,letterSpacing:".08em",textTransform:"uppercase"}}>
          ⏱ Departure Countdown — Thu Nov 26 · 3:00 PM
        </span>
        <div style={{height:2,flex:1,background:`linear-gradient(90deg,${T.amber},transparent)`,maxWidth:60}}/>
      </div>

      {/* Digit panels */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:10}}>
        {units.map(u=>(
          <div key={u.label} style={{textAlign:"center",position:"relative"}}>
            {/* Flip-clock panel */}
            <div style={{background:T.bg,border:`2px solid ${u.color}44`,borderRadius:6,padding:"10px 4px",
              boxShadow:`0 0 14px ${u.glow}33, inset 0 1px 0 ${u.glow}22`,
              position:"relative",overflow:"hidden"}}>
              {/* Scanline effect */}
              <div style={{position:"absolute",inset:0,backgroundImage:"repeating-linear-gradient(0deg,transparent,transparent 3px,rgba(0,0,0,.15) 3px,rgba(0,0,0,.15) 4px)",pointerEvents:"none"}}/>
              {/* Centre divide */}
              <div style={{position:"absolute",left:0,right:0,top:"50%",height:1,background:`${u.color}33`,pointerEvents:"none"}}/>
              <div style={{fontFamily:"'Courier New',Courier,monospace",fontSize:"clamp(22px,5vw,34px)",
                fontWeight:700,color:u.color,lineHeight:1,
                textShadow:`0 0 12px ${u.glow}cc, 0 0 30px ${u.glow}66`,
                letterSpacing:".05em",position:"relative"}}>
                {pads(u.val)}
              </div>
            </div>
            <div style={{fontFamily:"'Cinzel',serif",fontSize:9,color:T.hint,fontWeight:700,
              letterSpacing:".1em",marginTop:5,textTransform:"uppercase"}}>
              {u.label}
            </div>
          </div>
        ))}
      </div>

      {/* Progress bar */}
      {(()=>{
        const total = DEPARTURE_TIME - new Date("2026-01-01").getTime();
        const elapsed = total - time.diff;
        const pct = Math.min(100, Math.max(0, (elapsed/total)*100));
        return (
          <div style={{marginTop:14}}>
            <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
              <span style={{fontSize:10,color:T.hint,fontFamily:"'Cinzel',serif",letterSpacing:".05em"}}>LOADING PROGRESS</span>
              <span style={{fontSize:10,color:T.amber,fontFamily:"'Cinzel',serif"}}>{pct.toFixed(1)}%</span>
            </div>
            <div style={{background:T.surface,borderRadius:3,height:8,overflow:"hidden",border:`1px solid ${T.border}`}}>
              <div style={{height:"100%",width:`${pct}%`,borderRadius:3,
                background:`linear-gradient(90deg,${T.tealDim},${T.amber},${T.amberGlow})`,
                transition:"width 1s linear",boxShadow:`0 0 8px ${T.amber}66`}}/>
            </div>
          </div>
        );
      })()}
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
export function Dashboard({ctx}){
  const {games,food,supplies,users,authUser,doToggleLike,setView}=ctx;

  // Hooks must be declared first (React rules of hooks)
  const [catFilter,setCatFilter] = useState("");

  // Derived state
  const gList=Object.values(games), fList=Object.values(food), sList=Object.values(supplies), uList=Object.values(users);
  const realGames   = gList.filter(g=>!g.isRequest);
  const reqGames    = gList.filter(g=>g.isRequest);
  const sortedReal  = [...realGames].sort((a,b)=>(b.likes?.length||0)-(a.likes?.length||0));
  const sortedReq   = [...reqGames].sort((a,b)=>(b.likes?.length||0)-(a.likes?.length||0));
  const maxLikesReq = sortedReq[0]?.likes?.length||1;
  const filteredReal = catFilter ? sortedReal.filter(g=>g.category===catFilter) : sortedReal;
  const filteredMax  = filteredReal[0]?.likes?.length||1;

  const fByCat=FOOD_CATS.reduce((acc,c)=>{acc[c]=fList.filter(f=>f.category===c).length;return acc;},{});
  const topCats=Object.entries(fByCat).filter(([,v])=>v>0).sort((a,b)=>b[1]-a[1]);
  const medal=["🥇","🥈","🥉"];

  // Shared game row renderer
  const renderGameRow = ({g,i,maxL,barAccent}) => {
    const likes=g.likes?.length||0, liked=g.likes?.includes(authUser?.uid);
    const pct=Math.round((likes/maxL)*100);
    const owner=users[g.ownerId];
    const cc=g.category?GAME_CAT_COLORS[g.category]:null;
    const barColor=barAccent?barAccent(i)
      :i===0?`linear-gradient(90deg,#C8A028,#F0C040)`
      :i===1?`linear-gradient(90deg,#888,#BBB)`
      :i===2?`linear-gradient(90deg,#A06040,#C08060)`
      :`linear-gradient(90deg,${T.amber},${T.amberGlow})`;
    return <div key={g.id} style={{display:"flex",alignItems:"center",gap:10,marginBottom:12}}>
      <span style={{width:36,textAlign:"center",fontSize:i<3?18:12,fontFamily:"'Cinzel',serif",fontWeight:700,color:i<3?"inherit":T.muted,flexShrink:0}}>
        {medal[i]||`#${i+1}`}
      </span>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4,flexWrap:"wrap",gap:4}}>
          <div style={{display:"flex",alignItems:"center",gap:5,minWidth:0,flexWrap:"wrap"}}>
            <span style={{fontSize:13,fontWeight:600,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:150}}>{g.name}</span>
            {cc&&<span style={{fontSize:10,padding:"2px 6px",borderRadius:3,background:cc.bg,color:cc.text,border:`1px solid ${cc.border}`,fontWeight:700,display:"inline-flex",alignItems:"center",gap:2}}><span style={{fontSize:11}}>{cc.icon}</span>{g.category}</span>}
            {owner&&<Avatar name={owner.name} picture={owner.picture} size={28}/>}
          </div>
          <div style={{display:"flex",alignItems:"center",gap:5,flexShrink:0}}>
            <span style={{fontSize:11,color:T.muted,fontFamily:"'Cinzel',serif"}}>{likes} vote{likes!==1?"s":""}</span>
            <button onClick={()=>doToggleLike(g.id)}
              style={{background:liked?T.amberSoft:"transparent",border:`1.5px solid ${liked?T.amber:T.border2}`,borderRadius:4,padding:"3px 9px",fontSize:11,color:liked?T.amber:T.muted,cursor:"pointer",display:"inline-flex",alignItems:"center",gap:3,transition:"all .15s",fontFamily:"'Cinzel',serif",fontWeight:600}}>
              <i className="ti ti-heart" style={{fontSize:11}}/>{liked?"Voted":"Vote"}
            </button>
          </div>
        </div>
        <div style={{background:T.surface,borderRadius:3,height:8,overflow:"hidden",border:`1px solid ${T.border}`}}>
          <div style={{height:"100%",width:`${pct||0}%`,background:barColor,borderRadius:3,transition:"width .8s ease",boxShadow:i===0?`0 0 6px ${T.amber}88`:"none"}}/>
        </div>
      </div>
    </div>;
  };

  return <div className="cc-fade">
    <SectionTitle sub="Live telemetry — all gauges update in real time">The Bridge</SectionTitle>

    <CountdownTimer/>

    {/* ── Clickable stat cards ── */}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(120px,1fr))",gap:12,marginBottom:24}}>
      {[
        {label:"Crew",       val:uList.length,                                        emoji:"👓", color:"#50C8FF", glow:"#50C8FF", nav:"deckhands"},
        {label:"Cargo Hold", val:realGames.length,                                    emoji:"🎲", color:"#FFD060", glow:"#FFD060", nav:"games"},
        {label:"Votes",      val:gList.reduce((s,g)=>s+(g.likes?.length||0),0),      emoji:"❤️", color:"#FF6070", glow:"#FF6070", nav:"games"},
        {label:"Provisions", val:fList.length,                                        emoji:"🍲", color:"#70DD80", glow:"#70DD80", nav:"potluck"},
        {label:"Gear",       val:sList.length,                                        emoji:"⚙️", color:"#ee7b2e", glow:"#ee7b2e", nav:"potluck"},
      ].map(s=>(
        <div key={s.label}
          onClick={()=>s.nav&&setView(s.nav)}
          style={{background:T.surface,border:`3px solid ${T.border2}`,borderRadius:8,padding:"16px 8px",textAlign:"center",position:"relative",overflow:"hidden",
            backgroundImage:`linear-gradient(180deg,${T.surface} 0%,${T.surface2} 100%)`,
            cursor:s.nav?"pointer":"default",transition:"all .18s",userSelect:"none"}}
          onMouseEnter={e=>{if(s.nav){e.currentTarget.style.borderColor=s.color;e.currentTarget.style.transform="translateY(-2px)";e.currentTarget.style.boxShadow=`0 6px 20px ${s.glow}44`;}}}
          onMouseLeave={e=>{if(s.nav){e.currentTarget.style.borderColor=T.border2;e.currentTarget.style.transform="";e.currentTarget.style.boxShadow="";}}}
        >
          <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,transparent,${s.glow},transparent)`}}/>
          <div style={{position:"absolute",bottom:0,left:0,right:0,height:60,background:`radial-gradient(ellipse at 50% 100%,${s.glow}18 0%,transparent 70%)`,pointerEvents:"none"}}/>
          <Rivet style={{top:-2,left:-2}}/><Rivet style={{top:-2,right:-2}}/>
          <Rivet style={{bottom:-2,left:-2}}/><Rivet style={{bottom:-2,right:-2}}/>
          <div style={{fontSize:36,lineHeight:1,marginBottom:8,filter:`drop-shadow(0 0 8px ${s.glow}88)`}}>{s.emoji}</div>
          <div style={{fontFamily:"'Cinzel',serif",fontSize:24,color:s.color,fontWeight:700,marginBottom:3,textShadow:`0 0 14px ${s.glow}99`}}>{s.val}</div>
          <div style={{fontSize:10,color:T.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".06em"}}>{s.label}</div>
          {s.nav&&<div style={{fontSize:9,color:s.color,marginTop:5,fontFamily:"'Cinzel',serif",opacity:.8,letterSpacing:".06em"}}>TAP TO VIEW →</div>}
        </div>
      ))}
    </div>

    {/* ── Popular games leaderboard ── */}
    {sortedReal.length>0&&<Card style={{marginBottom:20,background:T.bgMid,border:`2px solid ${T.border2}`,overflow:"hidden"}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,${T.amber},${T.amberGlow},${T.amber})`}}/>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.amber,letterSpacing:".05em",display:"flex",alignItems:"center",gap:7}}>
          <i className="ti ti-trophy"/> Most Popular Games
        </h3>
        <div style={{display:"flex",gap:5,flexWrap:"wrap",alignItems:"center"}}>
          <span style={{fontSize:10,color:T.hint,fontWeight:600,letterSpacing:".05em"}}>FILTER:</span>
          <button onClick={()=>setCatFilter("")}
            style={{fontFamily:"'Cinzel',serif",fontSize:10,padding:"3px 8px",borderRadius:3,border:`1.5px solid ${!catFilter?T.amber:T.border}`,cursor:"pointer",background:!catFilter?T.amberSoft:"transparent",color:!catFilter?T.amber:T.muted,fontWeight:700,transition:"all .15s"}}>
            All
          </button>
          {GAME_CATS.map(cat=>{const cc=GAME_CAT_COLORS[cat]; const active=catFilter===cat;
            return <button key={cat} onClick={()=>setCatFilter(active?"":cat)}
              style={{fontFamily:"inherit",fontSize:10,padding:"3px 8px",borderRadius:3,
                border:`1.5px solid ${active?cc.border:T.border}`,cursor:"pointer",
                background:active?cc.bg:"transparent",color:active?cc.text:T.muted,
                transition:"all .15s",display:"inline-flex",alignItems:"center",gap:2,fontWeight:active?700:400,
                boxShadow:active?`0 0 6px ${cc.glow}44`:undefined}}>
              <span style={{fontSize:12}}>{cc.icon}</span>{cat}
            </button>;
          })}
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column"}}>
        {filteredReal.slice(0,10).map((g,i)=>renderGameRow({g,i,maxL:filteredMax}))}
        {filteredReal.length===0&&<p style={{color:T.hint,fontSize:13,textAlign:"center",padding:"12px 0",fontStyle:"italic"}}>No games in this category yet.</p>}
      </div>
      {filteredReal.length>10&&<div style={{marginTop:4,fontSize:12,color:T.hint,textAlign:"center",fontStyle:"italic"}}>and {filteredReal.length-10} more…</div>}
    </Card>}

    {/* ── Most Popular Requests ── */}
    {sortedReq.length>0&&<Card style={{marginBottom:20,background:T.bgMid,border:`2px solid ${T.copper}55`,overflow:"hidden"}}>
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,${T.copper},${T.muted},${T.copper})`}}/>
      <h3 style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.copper,marginBottom:14,letterSpacing:".05em",display:"flex",alignItems:"center",gap:7}}>
        📜 Most Requested Games
      </h3>
      <div style={{display:"flex",flexDirection:"column"}}>
        {sortedReq.slice(0,5).map((g,i)=>renderGameRow({g,i,maxL:maxLikesReq,
          barAccent:j=>j===0?`linear-gradient(90deg,${T.copper},${T.amberGlow})`:j===1?`linear-gradient(90deg,${T.amber},${T.copper})`:j===2?`linear-gradient(90deg,${T.steam},${T.amber})`:`linear-gradient(90deg,${T.muted},${T.hint})`
        }))}
      </div>
      {sortedReq.length>5&&<div style={{marginTop:4,fontSize:12,color:T.hint,textAlign:"center",fontStyle:"italic"}}>and {sortedReq.length-5} more requests…</div>}
    </Card>}

    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(260px,1fr))",gap:18,marginBottom:20}}>
      {/* Provisions overview */}
      <Card style={{background:T.bgMid}}>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,marginBottom:14,letterSpacing:".05em"}}><i className="ti ti-tool-kitchen-2"/> Galley Manifest</h3>
        {fList.length===0&&sList.length===0?<p style={{color:T.hint,fontSize:13,textAlign:"center",padding:"14px 0"}}>No provisions logged</p>:<>
          {topCats.length>0&&<div style={{marginBottom:12}}>
            <span style={{fontSize:10,color:T.muted,fontWeight:600,display:"block",marginBottom:7,textTransform:"uppercase",letterSpacing:".06em"}}>Food by category</span>
            <div style={{display:"flex",flexWrap:"wrap",gap:5}}>{topCats.map(([c,n])=><Chip key={c} color="amber">{c} ({n})</Chip>)}</div>
          </div>}
          <BrassRule/>
          <span style={{fontSize:10,color:T.muted,fontWeight:600,display:"block",margin:"10px 0 7px",textTransform:"uppercase",letterSpacing:".06em"}}>Who's bringing what</span>
          <div style={{display:"flex",flexDirection:"column",gap:7,maxHeight:160,overflowY:"auto"}}>
            {uList.map(u=>{const mf=fList.filter(f=>f.ownerId===u.id),ms=sList.filter(s=>s.ownerId===u.id);if(!mf.length&&!ms.length)return null;
              return <div key={u.id} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
                <Avatar name={u.name} picture={u.picture} size={40}/>
                <span style={{fontSize:12,color:T.muted,lineHeight:1.5}}><strong style={{color:T.text}}>{u.name.split(" ")[0]}:</strong> {[...mf.map(f=>f.name),...ms.map(s=>s.name)].join(", ")}</span>
              </div>;}).filter(Boolean)}
          </div>
        </>}
      </Card>

      {/* Crew Roster preview — tap to open Deck Hands */}
      <div onClick={()=>setView("deckhands")}
        style={{background:T.bgMid,border:`3px solid ${T.border2}`,borderRadius:8,padding:"18px 20px",
          position:"relative",cursor:"pointer",transition:"all .18s",userSelect:"none",
          backgroundImage:`linear-gradient(135deg,${T.surface} 0%,${T.surface2} 100%)`,
          boxShadow:`inset 0 1px 0 ${T.borderGlow}44, 0 4px 16px rgba(0,0,0,.5)`}}
        onMouseEnter={e=>{e.currentTarget.style.borderColor=T.borderGlow;e.currentTarget.style.transform="translateY(-2px)";}}
        onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border2;e.currentTarget.style.transform="";}}>
        <Rivet style={{top:-2,left:-2}}/><Rivet style={{top:-2,right:-2}}/>
        <Rivet style={{bottom:-2,left:-2}}/><Rivet style={{bottom:-2,right:-2}}/>
        {/* Header */}
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <h3 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,letterSpacing:".05em"}}>
            <i className="ti ti-users"/> Crew Roster
          </h3>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <span style={{fontFamily:"'Cinzel',serif",fontSize:11,color:T.muted,letterSpacing:".04em"}}>ABOARD:</span>
            <div style={{display:"flex",alignItems:"center",justifyContent:"center",minWidth:36,height:36,borderRadius:6,
              background:T.amberSoft,border:`2px solid ${T.border2}`,boxShadow:`0 0 10px ${T.amber}55`}}>
              <span style={{fontFamily:"'Cinzel',serif",fontSize:18,fontWeight:700,color:T.amberGlow,
                textShadow:`0 0 10px ${T.amber}99`,lineHeight:1}}>{uList.length}</span>
            </div>
          </div>
        </div>
        {/* Crew avatar strip — show up to 5 */}
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
          {uList.slice(0,5).map((u,i)=>{
            const rank=u.crewRank||"Enlisted";
            const rc=CREW_RANKS[rank]||CREW_RANKS["Enlisted"];
            return <div key={u.id} style={{display:"flex",flexDirection:"column",alignItems:"center",gap:4}}>
              <Avatar name={u.name} picture={u.picture} size={48}/>
              <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:rc.bg,color:rc.text,
                border:`1px solid ${rc.border}`,fontFamily:"'Cinzel',serif",fontWeight:700,letterSpacing:".03em"}}>
                {rc.icon}
              </span>
              {u.deposit!==undefined&&<span title={u.deposit?"Deposit received":"Deposit pending"} style={{fontSize:11}}>{u.deposit?"💰":"⬜"}</span>}
            </div>;
          })}
          {uList.length>5&&<div style={{display:"flex",alignItems:"center",justifyContent:"center",width:48,height:48,
            borderRadius:"50%",background:T.surface2,border:`2px solid ${T.border}`,fontSize:12,color:T.muted,fontFamily:"'Cinzel',serif"}}>
            +{uList.length-5}
          </div>}
        </div>
        {/* Tap to view */}
        <div style={{textAlign:"center",fontSize:11,color:T.amber,fontFamily:"'Cinzel',serif",fontWeight:700,
          letterSpacing:".06em",padding:"6px 0",borderTop:`1px solid ${T.border}`,marginTop:4}}>
          TAP TO VIEW DECK HANDS →
        </div>
      </div>

    </div>
  </div>;
}

// ── Game Chest with Edit ──────────────────────────────────────────────────────
// Small bordered action button/link used on game rows
export function IconBtn({onClick,title,children,active,activeColor,disabled,danger,href,as="button"}) {
  const base={display:"inline-flex",alignItems:"center",justifyContent:"center",gap:3,
    borderRadius:5,padding:"5px 8px",fontSize:12,fontWeight:700,transition:"all .15s",
    cursor:disabled?"default":"pointer",position:"relative"};
  const style=active
    ?{...base,background:activeColor?(activeColor+"22"):T.amberSoft,border:`1.5px solid ${activeColor||T.amber}`,color:activeColor||T.amber,opacity:disabled?.35:1}
    :{...base,background:"transparent",border:`1.5px solid ${danger?T.danger+"44":T.border2}`,color:danger?T.danger:T.muted,opacity:disabled?.35:1};
  const props={style,title,disabled,onClick,
    onMouseEnter:e=>{if(!disabled){e.currentTarget.style.borderColor=danger?T.danger:activeColor||T.amber;e.currentTarget.style.color=danger?T.danger:activeColor||T.amber;}},
    onMouseLeave:e=>{e.currentTarget.style.borderColor=active?(activeColor||T.amber):(danger?T.danger+"44":T.border2);e.currentTarget.style.color=active?(activeColor||T.amber):(danger?T.danger:T.muted);}};
  if(as==="a") return <a href={href} target="_blank" rel="noreferrer" {...props}>{children}</a>;
  return <button {...props}>{children}</button>;
}

export function GameChest({ctx}){
  const {games,users,authUser,profile,food,doSaveGame,doDelGame,doToggleLike,doLogGamePlayed,doRemoveGamePlayed,showToast}=ctx;
  const [showAdd,setShowAdd]     = useState(false);
  const [showReq,setShowReq]     = useState(false);
  const [editGame,setEditGame]   = useState(null);
  const [form,setForm]           = useState({name:"",minP:"",maxP:"",category:""});
  const [reqName,setReqName]     = useState("");
  const [reqNote,setReqNote]     = useState("");
  const [filter,setFilter]       = useState("all");
  const [catFilter,setCatFilter] = useState("");
  const [search,setSearch]       = useState("");
  const [sortBy,setSortBy]       = useState("category"); // name | votes | category
  const [showAI,setShowAI]       = useState(false);

  const gList = Object.values(games);

  // Requests are games marked isRequest:true
  const realGames = gList.filter(g=>!g.isRequest);
  const requests  = gList.filter(g=>g.isRequest);

  const bggUrl = name => name ? `https://boardgamegeek.com/search/boardgame?q=${encodeURIComponent(name)}` : "";
  const [lookingUp, setLookingUp] = useState(false);
  const [bggCandidates, setBggCandidates] = useState([]); // close BGG titles offered when there is no exact match
  const [openRows, setOpenRows] = useState({}); // expanded game rows, keyed by game id
  const addFormRef = useRef(null);
  const nameInputRef = useRef(null);

  // On name blur — auto-lookup BGG to get exact URL + description + player counts
  // Fill the add-game form from a lookup result. Never overwrites player counts the user already typed.
  const applyBggToForm = (bggData) => {
    const autoDesc = decodeHtml(decodeHtml(bggData.description||"")).slice(0,200);
    console.log("[autoBGG] name:", bggData.name, "| weight:", bggData.weight, "| url:", bggData.bggUrl);
    // Resolve player counts from the latest form state (not the render this lookup started in)
    setForm(f=>{
      const resolvedMinP = f.minP || bggData.minPlayers;
      const resolvedMaxP = f.maxP || bggData.maxPlayers;
      return {...f,
        name:          (bggData.source==="index" ? bggData.name : cleanGameName(bggData.name)) || f.name,
        bggUrlOverride: bggData.bggUrl,
        minP:          resolvedMinP,
        maxP:          resolvedMaxP,
        desc:          autoDesc || f.desc,
        category:      f.category || detectCategory(bggData.weight, resolvedMinP, resolvedMaxP),
      };
    });
    setBggCandidates(bggData.candidates || []);
    showToast(bggData.source==="search" && bggData.candidates?.length
      ? `⚠️ No exact BGG match for "${bggData.name}" — pick a suggestion below`
      : `✓ BGG: ${bggData.name} (${bggData.rating}/10)`);
  };

  const autoBGG = async (name) => {
    if(!name.trim() || form.bggUrlOverride) return; // skip if already have exact URL
    setLookingUp(true);
    try {
      const bggData = await lookupBGG(name.trim());
      if(bggData) applyBggToForm(bggData);
    } catch(e){ /* silent */ }
    setLookingUp(false);
  };

  // The user picked one of the suggested BGG titles
  const pickBggCandidate = async (candidate) => {
    setBggCandidates([]);
    setLookingUp(true);
    try {
      const bggData = await lookupBGG(candidate.name, candidate);
      if(bggData) applyBggToForm(bggData);
    } catch(e){ /* silent */ }
    setLookingUp(false);
  };

  // Decode HTML entities helper (also used in autoBGG)
  const decodeHtml = (str) => str
    .replace(/&amp;/g,"&").replace(/&lt;/g,"<").replace(/&gt;/g,">")
    .replace(/&quot;/g,'"').replace(/&#39;/g,"'").replace(/&mdash;/g,"—")
    .replace(/&ndash;/g,"–").replace(/&hellip;/g,"…").replace(/&nbsp;/g," ")
    .replace(/&#10;/g," ").replace(/&#13;/g," ").replace(/&amp;#10;/g," ")
    .replace(/&amp;amp;/g,"&").replace(/<br\s*\/?>/gi," ").replace(/<[^>]+>/g,"")
    .replace(/\s{2,}/g," ").trim();
  const [scanning, setScanning]   = useState(false);
  const [scanErr,  setScanErr]    = useState("");
  const photoRef = useRef();

  // Scan a box photo with Gemini vision → extract game name, player count, BGG data
  const scanGamePhoto = async (dataUrl) => {
    setScanning(true); setScanErr("");
    try {
      const text = await geminiVision(dataUrl,
        "Look at this image carefully. Is this a board game box or packaging? If YES, extract: 1) The exact game name printed on the box. 2) Minimum players. 3) Maximum players. Reply in EXACTLY this format with nothing else:\nIF it is a board game box: NAME: <game name> MINP: <number> MAXP: <number>\nIF it is NOT a board game box (e.g. food, person, scenery, other product): NOT_A_GAME\nDo not guess or hallucinate. Only reply NOT_A_GAME or the exact format above.",
        "Scan failed");
      console.log("[Game scan]", text);

      // Check if Gemini says it's not a game
      if(text.trim().toUpperCase().includes("NOT_A_GAME")){
        throw new Error("That doesn't look like a board game box. Try a photo of the front of a game box.");
      }

      const nameMatch = text.match(/NAME:\s*(.+)/i);
      const minpMatch = text.match(/MINP:\s*(\d+)/i);
      const maxpMatch = text.match(/MAXP:\s*(\d+)/i);

      if(!nameMatch?.[1]) throw new Error("Couldn't read game name from the photo. Try a clearer shot of the box front.");

      const gameName = cleanGameName(nameMatch[1]);

      // Update form immediately with what we know
      setForm(f=>({...f,
        name: gameName,
        minP: minpMatch?.[1] || f.minP,
        maxP: maxpMatch?.[1] || f.maxP,
      }));

      // Now look up BGG for the exact URL and confirm details
      showToast("📸 Game identified! Looking up BGG details…");
      const bggData = await lookupBGG(gameName);
      setBggCandidates(bggData?.candidates || []);
      if(bggData){
        const cleanBggName = bggData.source==="index" ? bggData.name : cleanGameName(bggData.name || gameName);
        const cleanedDesc = bggData.description
          ? decodeHtml(decodeHtml(bggData.description)).slice(0, 200)
          : "";
        const scannedMinP = bggData.minPlayers || minpMatch?.[1] || "";
        const scannedMaxP = bggData.maxPlayers || maxpMatch?.[1] || "";
        const autoCategory = detectCategory(bggData.weight, scannedMinP, scannedMaxP);
        setForm(f=>({...f,
          name:         cleanBggName,
          minP:         scannedMinP,
          maxP:         scannedMaxP,
          bggUrlOverride: bggData.bggUrl,
          desc:         cleanedDesc || f.desc,
          category:     autoCategory || f.category,
        }));
        if(autoCategory) console.log("[Scan] Auto-category:", autoCategory, "(weight:", bggData.weight, ")");
        console.log("[Scan] name:", cleanBggName, "| desc:", cleanedDesc.slice(0,60), "| url:", bggData.bggUrl);
        showToast(bggData.source==="search" && bggData.candidates?.length
          ? `⚠️ No exact BGG match for "${gameName}" — pick a suggestion below`
          : `✓ Found on BGG: ${bggData.name} (${bggData.rating}/10)`);
      } else {
        showToast(`✓ Identified: ${gameName} — no BGG match found`);
      }
    } catch(e){
      console.error("[Game scan] error:", e);
      setScanErr(e.message || "Scan failed. Try a clearer photo of the box front.");
    }
    setScanning(false);
  };

  const openAdd  = () => { setBggCandidates([]); setForm({name:"",minP:"",maxP:"",category:"",bggUrlOverride:"",desc:""}); setEditGame(null); setShowAdd(true); setShowReq(false); setScanErr(""); };
  const openEdit = g => {
    setForm({name:g.name,minP:g.minPlayers||"",maxP:g.maxPlayers||"",category:g.category||"",bggUrlOverride:g.bggUrl||"",desc:g.description||""});
    setBggCandidates([]); setEditGame(g); setShowAdd(true); setShowReq(false); setScanErr("");
    setTimeout(()=>{
      addFormRef.current?.scrollIntoView({behavior:"smooth",block:"start"});
      setTimeout(()=>nameInputRef.current?.focus(),150);
    },50);
  };
  const closeAll = () => { setShowAdd(false); setShowReq(false); setEditGame(null); setReqName(""); setReqNote(""); };

  const save = async () => {
    if(!form.name.trim()) return;
    const gameData = {name:form.name.trim(),bggUrl:form.bggUrlOverride||bggUrl(form.name.trim()),minPlayers:form.minP,maxPlayers:form.maxP,category:form.category,description:form.desc?.trim()||''};
    if(editGame){
      await doSaveGame({...editGame,...gameData});
      showToast("Game updated! ✏️");
    } else {
      await doSaveGame({id:uid(),...gameData,ownerId:authUser.uid,likes:[],isRequest:false});
      showToast("Game loaded into the hold! 🎲");
    }
    closeAll();
  };

  const saveRequest = async () => {
    if(!reqName.trim()) return;
    await doSaveGame({id:uid(),name:reqName.trim(),bggUrl:bggUrl(reqName.trim()),notes:reqNote.trim(),ownerId:authUser.uid,likes:[],isRequest:true,category:"",minPlayers:"",maxPlayers:""});
    showToast("Game requested! 📜");
    closeAll();
  };

  // Filter + search + sort pipeline
  let visible = filter==="mine"  ? realGames.filter(g=>g.ownerId===authUser?.uid)
              : filter==="liked" ? realGames.filter(g=>g.likes?.includes(authUser?.uid))
              : realGames;
  if(catFilter)   visible = visible.filter(g=>g.category===catFilter);
  if(search.trim()) visible = visible.filter(g=>g.name.toLowerCase().includes(search.toLowerCase().trim()));
  if(sortBy==="votes")    visible = [...visible].sort((a,b)=>(b.likes?.length||0)-(a.likes?.length||0));
  else if(sortBy==="category") visible = [...visible].sort((a,b)=>(a.category||"").localeCompare(b.category||""));
  else visible = [...visible].sort((a,b)=>a.name.localeCompare(b.name));

  return <div className="cc-fade">
    {/* Header */}
    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:10}}>
      <SectionTitle sub={`${realGames.length} game${realGames.length!==1?"s":""} · ${requests.length} requested`}>Cargo Hold</SectionTitle>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        <Btn onClick={openAdd}  size="sm"><i className="ti ti-plus"/> Load Cargo</Btn>
        <Btn onClick={()=>{setShowReq(!showReq);setShowAdd(false);}} variant="ghost" size="sm"><i className="ti ti-message-plus"/> Request Game</Btn>
        <Btn onClick={()=>{setShowAI(!showAI);setShowAdd(false);setShowReq(false);}} variant="ghost" size="sm" style={{borderColor:showAI?T.amber:undefined,color:showAI?T.amber:T.text}}>🤖 Recommend</Btn>
      </div>
    </div>

    {/* Add/Edit form */}
    {showAdd&&<Card ref={addFormRef} style={{marginBottom:20,border:`2.5px solid ${T.amber}88`,background:T.bgMid}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber,letterSpacing:".04em"}}>
          {editGame?"⚙️ Modify Cargo Entry":"📦 New Cargo Entry"}
        </h3>
        {!editGame&&<>
          <input ref={photoRef} type="file" accept="image/*" capture="environment" style={{display:"none"}}
            onChange={async e=>{
              const f=e.target.files?.[0]; if(!f) return;
              const reader=new FileReader();
              reader.onload=async ev=>{
                const compressed=await compressImage(ev.target.result).catch(()=>ev.target.result);
                scanGamePhoto(compressed);
              };
              reader.readAsDataURL(f);
              e.target.value="";
            }}/>
          <button onClick={()=>photoRef.current.click()} disabled={scanning}
            style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"7px 14px",
              borderRadius:6,border:`2px solid ${T.steam}`,background:scanning?T.surface:T.steamSoft,
              color:T.steam,cursor:scanning?"wait":"pointer",display:"flex",alignItems:"center",gap:6,
              boxShadow:scanning?undefined:`0 0 10px ${T.steam}33`,transition:"all .2s"}}>
            {scanning
              ? <><span style={{display:"inline-block",animation:"ccSpin 1s linear infinite"}}>⚙️</span> Scanning…</>
              : <><i className="ti ti-camera" style={{fontSize:14}}/> Scan Box</>}
          </button>
        </>}
      </div>
      {scanErr&&<div style={{marginBottom:12,padding:"8px 12px",borderRadius:6,background:T.dangerBg,border:`1px solid ${T.danger}44`,color:T.danger,fontSize:12}}>⚠️ {scanErr}</div>}
      <div style={{marginBottom:12}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em"}}>BGG URL</span>
          {form.bggUrlOverride&&<a href={form.bggUrlOverride} target="_blank" rel="noreferrer"
            style={{fontSize:10,color:T.steam,textDecoration:"none",display:"flex",alignItems:"center",gap:3}}>
            <i className="ti ti-external-link" style={{fontSize:10}}/> Open
          </a>}
        </div>
        <input
          value={form.bggUrlOverride||""}
          onChange={e=>setForm(f=>({...f,bggUrlOverride:e.target.value}))}
          placeholder="https://boardgamegeek.com/boardgame/266192 (auto-filled or paste manually)"
          style={{width:"100%",fontFamily:"inherit",fontSize:12,padding:"8px 12px",
            borderRadius:6,border:`2px solid ${form.bggUrlOverride?T.steam+"88":T.border2}`,
            background:T.surface2,color:T.text,outline:"none",boxSizing:"border-box"}}
        />
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(180px,1fr))",gap:12,marginBottom:12}}>
        <div style={{gridColumn:"1/-1",position:"relative"}}>
          <Inp label={lookingUp?"Game name * (looking up BGG…)":"Game name *"} placeholder="e.g. Wingspan"
            value={form.name}
            inputRef={nameInputRef}
            onChange={e=>{setBggCandidates([]);setForm(f=>({...f,name:e.target.value,bggUrlOverride:"",desc:""}));}}
            onBlur={e=>autoBGG(e.target.value)}
          />
          {lookingUp&&<div style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
            fontSize:11,color:T.steam,display:"flex",alignItems:"center",gap:4}}>
            <span style={{display:"inline-block",animation:"ccSpin 1s linear infinite"}}>⚙️</span>
          </div>}
        </div>
        {bggCandidates.length>0&&<div style={{gridColumn:"1/-1",display:"flex",flexWrap:"wrap",alignItems:"center",gap:6}}>
          <span style={{fontSize:11,color:T.muted}}>No exact BGG match — did you mean:</span>
          {bggCandidates.map(c=><button key={c.id} onClick={()=>pickBggCandidate(c)}
            style={{fontFamily:"inherit",fontSize:12,padding:"4px 10px",borderRadius:4,cursor:"pointer",border:`1.5px solid ${T.steam}66`,background:T.steamSoft,color:T.steam}}>
            {c.name}{c.year?` (${c.year})`:""}
          </button>)}
        </div>}
        {form.name.trim()&&<div style={{gridColumn:"1/-1",display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:T.amberSoft,border:`2px solid ${T.border2}`,borderRadius:6}}>
          <i className="ti ti-link" style={{color:T.amber,fontSize:13}}/>
          <a href={bggUrl(form.name.trim())} target="_blank" rel="noreferrer" style={{fontSize:12,color:T.amber,textDecoration:"none",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            Search BoardGameGeek for "{form.name.trim()}"
          </a>
        </div>}
        <Inp label="Min players" type="number" placeholder="2" value={form.minP} onChange={e=>setForm(f=>({...f,minP:e.target.value}))}/>
        <Inp label="Max players" type="number" placeholder="5" value={form.maxP} onChange={e=>setForm(f=>({...f,maxP:e.target.value}))}/>
        <div style={{gridColumn:"1/-1"}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:6}}>
            <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em"}}>Short description</span>
            <span style={{fontSize:10,color:T.hint}}>{form.desc?.length||0}/200</span>
          </div>
          <textarea
            value={form.desc||""}
            onChange={e=>setForm(f=>({...f,desc:e.target.value.slice(0,200)}))}
            placeholder="e.g. Competitive engine-building game about birds — auto-filled from BGG when scanning"
            rows={2}
            style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"9px 12px",
              borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,
              color:T.text,outline:"none",resize:"vertical",lineHeight:1.5,boxSizing:"border-box"}}
          />
        </div>
        <div style={{gridColumn:"1/-1"}}>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:8}}>Weight / Category</span>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {GAME_CATS.map(cat=>{
              const cc=GAME_CAT_COLORS[cat]; const sel=form.category===cat;
              return <button key={cat} onClick={()=>setForm(f=>({...f,category:sel?"":cat}))}
                style={{fontFamily:"inherit",fontSize:13,padding:"6px 14px",borderRadius:4,
                  border:`2px solid ${sel?cc.border:T.border}`,background:sel?cc.bg:"transparent",
                  color:sel?cc.text:T.muted,cursor:"pointer",transition:"all .15s",fontWeight:sel?700:400,
                  display:"inline-flex",alignItems:"center",gap:5,
                  boxShadow:sel?`0 0 10px ${cc.glow}66`:"none"}}>
                <span style={{fontSize:16}}>{cc.icon}</span>{cat}
              </button>;
            })}
          </div>
        </div>
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <Btn variant="ghost" onClick={closeAll} size="sm">Cancel</Btn>
        <Btn onClick={save} disabled={!form.name.trim()} size="sm">{editGame?"Save Changes":"Load into Hold"}</Btn>
      </div>
    </Card>}

    {/* Request form */}
    {showReq&&<Card style={{marginBottom:20,border:`2.5px solid ${T.copper}88`,background:T.bgMid}}>
      <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.copper,marginBottom:14,letterSpacing:".04em"}}>
        📜 Request a Game
      </h3>
      <p style={{fontSize:12,color:T.muted,marginBottom:12}}>Don't own it but want to play it? Log a request and the crew can vote!</p>
      <div style={{display:"flex",flexDirection:"column",gap:12,marginBottom:12}}>
        <Inp label="Game name *" placeholder="e.g. Gloomhaven" value={reqName} onChange={e=>setReqName(e.target.value)}/>
        {reqName.trim()&&<div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:T.copperSoft,border:`2px solid ${T.copper}66`,borderRadius:6}}>
          <i className="ti ti-link" style={{color:T.copper,fontSize:13}}/>
          <a href={bggUrl(reqName.trim())} target="_blank" rel="noreferrer" style={{fontSize:12,color:T.copper,textDecoration:"none"}}>
            Search BGG for "{reqName.trim()}"
          </a>
        </div>}
        <Inp label="Notes (optional)" placeholder="e.g. Great with 4+ players!" value={reqNote} onChange={e=>setReqNote(e.target.value)}/>
      </div>
      <div style={{display:"flex",gap:8}}>
        <Btn variant="ghost" onClick={closeAll} size="sm">Cancel</Btn>
        <Btn onClick={saveRequest} disabled={!reqName.trim()} size="sm" variant="copper">📜 Submit Request</Btn>
      </div>
    </Card>}

    {/* AI Game Recommender */}
    {showAI&&<GameRecommender games={realGames} users={users} profile={profile} food={food}/>}

    {/* Search + Sort + Filter bar */}
    <Card style={{marginBottom:18,padding:"12px 14px",background:T.bgMid}}>
      <div style={{display:"flex",gap:10,flexWrap:"wrap",alignItems:"center"}}>
        {/* Search */}
        <div style={{flex:"1 1 160px",position:"relative"}}>
          <i className="ti ti-search" style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",color:T.muted,fontSize:14,pointerEvents:"none"}}/>
          <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search games…"
            style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"7px 10px 7px 32px",borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface,color:T.text,outline:"none"}}/>
          {search&&<button onClick={()=>setSearch("")} style={{position:"absolute",right:8,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:T.hint,fontSize:14}}>✕</button>}
        </div>
        {/* Sort */}
        <div style={{display:"flex",alignItems:"center",gap:5}}>
          <span style={{fontSize:11,color:T.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".05em",whiteSpace:"nowrap"}}>Sort:</span>
          {[["name","A–Z"],["votes","🏆 Votes"],["category","Category"]].map(([v,l])=>(
            <button key={v} onClick={()=>setSortBy(v)}
              style={{fontFamily:"'Cinzel',serif",fontSize:11,padding:"5px 10px",borderRadius:4,border:`2px solid ${sortBy===v?T.amber:T.border}`,cursor:"pointer",background:sortBy===v?T.amberSoft:"transparent",color:sortBy===v?T.amber:T.muted,transition:"all .15s",fontWeight:700,whiteSpace:"nowrap"}}>
              {l}
            </button>
          ))}
        </div>
      </div>
      {/* Category filter pills */}
      <div style={{display:"flex",gap:6,marginTop:10,flexWrap:"wrap",alignItems:"center"}}>
        <span style={{fontSize:11,color:T.muted,fontWeight:600,textTransform:"uppercase",letterSpacing:".05em"}}>Filter:</span>
        <button onClick={()=>setCatFilter("")}
          style={{fontFamily:"'Cinzel',serif",fontSize:11,padding:"4px 10px",borderRadius:4,border:`2px solid ${!catFilter?T.amber:T.border}`,cursor:"pointer",background:!catFilter?T.amberSoft:"transparent",color:!catFilter?T.amber:T.muted,transition:"all .15s",fontWeight:700}}>
          All
        </button>
        {GAME_CATS.map(cat=>{
          const cc=GAME_CAT_COLORS[cat]; const active=catFilter===cat;
          return <button key={cat} onClick={()=>setCatFilter(active?"":cat)}
            style={{fontFamily:"inherit",fontSize:11,padding:"4px 10px",borderRadius:4,
              border:`2px solid ${active?cc.border:T.border}`,cursor:"pointer",
              background:active?cc.bg:"transparent",color:active?cc.text:T.muted,
              transition:"all .15s",display:"inline-flex",alignItems:"center",gap:4,fontWeight:active?700:400,
              boxShadow:active?`0 0 8px ${cc.glow}44`:"none"}}>
            <span style={{fontSize:14}}>{cc.icon}</span>{cat}
          </button>;
        })}
        {/* Tab filter */}
        <div style={{marginLeft:"auto",display:"flex",gap:5}}>
          {[["all","All"],["mine","Mine"],["liked","Voted"]].map(([id,label])=>(
            <button key={id} onClick={()=>setFilter(id)}
              style={{fontFamily:"'Cinzel',serif",fontSize:11,padding:"4px 10px",borderRadius:4,border:`2px solid ${filter===id?T.amber:T.border}`,cursor:"pointer",transition:"all .15s",background:filter===id?T.amberSoft:"transparent",color:filter===id?T.amber:T.muted,fontWeight:700}}>
              {label}
            </button>
          ))}
        </div>
      </div>
    </Card>

    {/* Results count */}
    {(search||catFilter)&&<div style={{fontSize:12,color:T.muted,marginBottom:10,fontStyle:"italic"}}>
      Showing {visible.length} of {realGames.length} game{realGames.length!==1?"s":""}
      {search&&<span> matching "<strong style={{color:T.amber}}>{search}</strong>"</span>}
      {catFilter&&<span> in <strong style={{color:GAME_CAT_COLORS[catFilter]?.text||T.amber}}>{catFilter}</strong></span>}
    </div>}

    {/* Game list */}
    {visible.length===0
      ?<div style={{textAlign:"center",padding:"48px 0",color:T.hint}}>
        <i className="ti ti-chess" style={{fontSize:40,display:"block",marginBottom:10,color:T.border2}}/>
        <p style={{fontSize:13,fontFamily:"'Cinzel',serif",color:T.muted}}>
          {search?"No games match your search.":filter==="liked"?"No votes cast yet.":"The hold is empty!"}
        </p>
        {search&&<button onClick={()=>setSearch("")} style={{marginTop:10,fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,background:"none",border:"none",cursor:"pointer",textDecoration:"underline"}}>Clear search</button>}
      </div>
      :(()=>{
        // When sorted by category, group into sections
        const renderGameRow = (g) => {
          const expanded = !!openRows[g.id];
          const toggleExpanded = () => setOpenRows(r=>({...r,[g.id]:!r[g.id]}));
          const owner=users[g.ownerId], liked=g.likes?.includes(authUser?.uid), isOwner=g.ownerId===authUser?.uid;
          const cc=g.category?GAME_CAT_COLORS[g.category]:null;
          const players=g.minPlayers?(g.maxPlayers&&g.maxPlayers!==g.minPlayers?`${g.minPlayers}–${g.maxPlayers}`:g.minPlayers)+` players`:null;
          const hasPlayed=(profile?.gamesPlayed||[]).includes(g.name);
          const accentBg=cc?`linear-gradient(180deg,${cc.border},${cc.glow}88)`:`linear-gradient(180deg,${T.border2},${T.border})`;
          return <div key={g.id} style={{marginBottom:5}}>
            {/* Main row */}
            <div
              role="button" tabIndex={0}
              onClick={toggleExpanded}
              onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();toggleExpanded();}}}
              style={{
                display:"flex",alignItems:"stretch",gap:0,
                background:expanded?T.surface:T.bgMid,
                borderRadius:expanded?"7px 7px 0 0":7,
                border:`1.5px solid ${expanded?(cc?.border||T.amber):T.border2}`,
                borderBottom:expanded?"none":undefined,
                overflow:"hidden",cursor:"pointer",
                transition:"background .15s,border-color .15s",userSelect:"none",
                WebkitTapHighlightColor:"transparent",
                boxShadow:expanded?`0 0 0 1px ${cc?.border||T.amber}22`:undefined}}>
              {/* Category colour bar */}
              <div style={{width:4,flexShrink:0,background:accentBg}}/>
              {/* Name + meta */}
              <div style={{flex:1,padding:"10px 12px",minWidth:0,overflow:"hidden"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:expanded?0:2}}>
                  <span style={{fontFamily:"'Cinzel',serif",fontWeight:700,fontSize:13,color:T.text,
                    flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                    {g.name}
                  </span>
                  {owner&&<Avatar name={owner.name} picture={owner.picture} size={22}/>}
                  <i className={`ti ${expanded?"ti-chevron-up":"ti-chevron-down"}`}
                    style={{fontSize:12,color:T.hint,flexShrink:0,marginLeft:2}}/>
                </div>
                {!expanded&&<div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  {cc&&sortBy!=="category"&&<span style={{display:"inline-flex",alignItems:"center",gap:3,
                    fontSize:10,padding:"1px 6px",borderRadius:3,
                    background:cc.bg,color:cc.text,border:`1px solid ${cc.border}`,fontWeight:700}}>
                    <span style={{fontSize:11}}>{cc.icon}</span>{g.category}
                  </span>}
                  {players&&<span style={{fontSize:10,color:T.hint,display:"inline-flex",alignItems:"center",gap:2}}>
                    <i className="ti ti-users" style={{fontSize:10}}/>{players}
                  </span>}
                  {g.description&&<span style={{fontSize:10,color:T.hint,overflow:"hidden",
                    textOverflow:"ellipsis",whiteSpace:"nowrap",maxWidth:"100%",display:"block"}}>
                    {g.description}
                  </span>}
                </div>}
              </div>
              {/* Quick action buttons — pinned right, stop propagation */}
              <div
                onClick={e=>e.stopPropagation()}
                onTouchEnd={e=>e.stopPropagation()}
                style={{display:"flex",alignItems:"center",gap:2,padding:"0 8px",flexShrink:0,marginLeft:"auto"}}>
                <IconBtn as="a" href={g.bggUrl||bggUrl(g.name)}
                  title="Open on BoardGameGeek">
                  <i className="ti ti-chess-board" style={{fontSize:13}}/><span style={{fontSize:10}}>BGG</span>
                </IconBtn>
                <IconBtn onClick={()=>!isOwner&&doToggleLike(g.id)} disabled={isOwner}
                  active={liked} activeColor={T.amber}
                  title={isOwner?"You own this game — can't vote for your own":"❤️ Vote for this game"}>
                  <i className="ti ti-heart" style={{fontSize:12}}/>{g.likes?.length||0}
                </IconBtn>
              </div>
            </div>
            {/* Expanded panel */}
            {expanded&&<div onClick={e=>e.stopPropagation()} style={{
              background:T.surface,border:`1.5px solid ${cc?.border||T.amber}`,
              borderTop:`1px solid ${T.border}`,
              borderRadius:"0 0 7px 7px",padding:"12px 16px 14px",
              animation:"ccFadeIn .12s ease"}}>
              {/* Full description */}
              {g.description&&<p style={{fontSize:12,color:T.text,lineHeight:1.6,margin:"0 0 12px",
                fontStyle:"italic",borderLeft:`3px solid ${cc?.border||T.amber}44`,paddingLeft:10}}>
                {g.description}
              </p>}
              {/* Details row */}
              <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:12}}>
                {cc&&<span style={{display:"inline-flex",alignItems:"center",gap:4,fontSize:11,
                  padding:"3px 10px",borderRadius:4,background:cc.bg,color:cc.text,
                  border:`1.5px solid ${cc.border}`,fontWeight:700,boxShadow:`0 0 8px ${cc.glow}44`}}>
                  <span style={{fontSize:14}}>{cc.icon}</span>{g.category}
                </span>}
                {players&&<span style={{fontSize:11,color:T.muted,display:"inline-flex",alignItems:"center",gap:4}}>
                  <i className="ti ti-users" style={{fontSize:13,color:T.amber}}/>{players}
                </span>}
                {owner&&<span style={{fontSize:11,color:T.muted,display:"inline-flex",alignItems:"center",gap:5}}>
                  <Avatar name={owner.name} picture={owner.picture} size={20}/>
                  Added by <strong style={{color:T.text}}>{owner.name?.split(" ")[0]}</strong>
                </span>}
                {hasPlayed&&<span style={{fontSize:11,color:T.steam,display:"inline-flex",alignItems:"center",gap:3,
                  background:T.steamSoft,border:`1px solid ${T.steam}44`,borderRadius:4,padding:"2px 8px"}}>
                  <i className="ti ti-check" style={{fontSize:11}}/> You've played this
                </span>}
              </div>
              {/* Action buttons with labels */}
              <div style={{display:"flex",gap:6,flexWrap:"wrap",alignItems:"center"}}>
                <IconBtn as="a" href={g.bggUrl||bggUrl(g.name)}
                  title="Open BoardGameGeek page">
                  <i className="ti ti-chess-board" style={{fontSize:12}}/> BoardGameGeek
                </IconBtn>
                <IconBtn onClick={()=>!isOwner&&doToggleLike(g.id)} disabled={isOwner}
                  active={liked} activeColor={T.amber}
                  title={isOwner?"Can't vote for your own game":liked?"Remove your vote":"Vote for this game"}>
                  <i className="ti ti-heart" style={{fontSize:12}}/>
                  {liked?"Voted":"Vote"} ({g.likes?.length||0})
                </IconBtn>
                <IconBtn onClick={async()=>{
                  if(hasPlayed){await doRemoveGamePlayed(authUser.uid,g.name);showToast(`Removed ${g.name} from played.`);}
                  else{await doLogGamePlayed(authUser.uid,g.name);showToast(`🎲 ${g.name} logged!`);}
                }} active={hasPlayed} activeColor={T.steam}
                  title={hasPlayed?"Remove from your played list":"Mark as played at this con"}>
                  <i className={`ti ${hasPlayed?"ti-circle-check":"ti-dice"}`} style={{fontSize:12}}/>
                  {hasPlayed?"Played":"Log Play"}
                </IconBtn>
                {isOwner&&<>
                  <IconBtn onClick={()=>openEdit(g)} title="Edit this game entry">
                    <i className="ti ti-pencil" style={{fontSize:12}}/> Edit
                  </IconBtn>
                  <IconBtn onClick={()=>doDelGame(g.id)} danger title="Remove from cargo hold">
                    <i className="ti ti-trash" style={{fontSize:12}}/> Remove
                  </IconBtn>
                </>}
              </div>
            </div>}
          </div>;
        };

        if(sortBy==="category") {
          // Group by category, uncategorised last
          const groups = {};
          visible.forEach(g=>{
            const key=g.category||"__none__";
            if(!groups[key]) groups[key]=[];
            groups[key].push(g);
          });
          const catOrder=[...GAME_CATS,"__none__"];
          return <div>{catOrder.filter(k=>groups[k]).map(k=>{
            const cc=k!=="__none__"?GAME_CAT_COLORS[k]:null;
            return <div key={k} style={{marginBottom:18}}>
              <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8}}>
                {cc
                  ?<span style={{display:"inline-flex",alignItems:"center",gap:5,
                    fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,
                    color:cc.text,background:cc.bg,border:`1.5px solid ${cc.border}`,
                    borderRadius:5,padding:"3px 12px",
                    boxShadow:`0 0 10px ${cc.glow}44`}}>
                    <span style={{fontSize:15}}>{cc.icon}</span>{k}
                    <span style={{fontSize:10,opacity:.7,fontWeight:400}}>({groups[k].length})</span>
                  </span>
                  :<span style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.muted,fontWeight:600,padding:"3px 0"}}>
                    Uncategorised ({groups[k].length})
                  </span>}
                <div style={{flex:1,height:1,background:cc?`linear-gradient(90deg,${cc.border}44,transparent)`:T.border}}/>
              </div>
              {groups[k].map(renderGameRow)}
            </div>;
          })}</div>;
        }
        return <div>{visible.map(renderGameRow)}</div>;
      })()
    }

    {/* Requested games section */}
    {requests.length>0&&<>
      <div style={{margin:"28px 0 14px",display:"flex",alignItems:"center",gap:10}}>
        <div style={{height:2,width:24,background:`linear-gradient(90deg,${T.copper},transparent)`}}/>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.copper,letterSpacing:".04em"}}>📜 Requested Games</h3>
        <div style={{height:2,flex:1,background:`linear-gradient(90deg,${T.copper},transparent)`,maxWidth:80}}/>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(240px,1fr))",gap:14}}>
        {requests.map(g=>{
          const owner=users[g.ownerId], liked=g.likes?.includes(authUser?.uid), isOwner=g.ownerId===authUser?.uid;
          return <Card key={g.id} style={{background:T.bgMid,border:`2.5px solid ${T.copper}66`,transition:"all .2s"}}>
            <div style={{position:"absolute",top:-1,right:16,background:T.copper,color:"#fff",fontSize:9,padding:"2px 8px",borderRadius:"0 0 4px 4px",fontFamily:"'Cinzel',serif",fontWeight:700,letterSpacing:".04em"}}>REQUESTED</div>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:10}}>
              <div style={{flex:1,marginRight:8}}>
                <div style={{fontWeight:700,color:T.text,fontSize:14,marginBottom:5,fontFamily:"'Cinzel',serif"}}>{g.name}</div>
                {owner&&<div style={{display:"flex",alignItems:"center",gap:5}}>
                  <Avatar name={owner.name} picture={owner.picture} size={36}/>
                  <span style={{fontSize:11,color:T.hint}}>Requested by {isOwner?"you":owner.name}</span>
                </div>}
                {g.notes&&<div style={{fontSize:12,color:T.muted,marginTop:4,fontStyle:"italic"}}>"{g.notes}"</div>}
              </div>
              {isOwner&&<button onClick={()=>doDelGame(g.id)} title="Remove request"
                style={{background:T.dangerBg,border:`2px solid ${T.danger}44`,borderRadius:4,cursor:"pointer",color:T.danger,fontSize:13,padding:"4px 7px"}}>
                <i className="ti ti-trash"/>
              </button>}
            </div>
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",paddingTop:8,borderTop:`1px solid ${T.border}`}}>
              <a href={g.bggUrl||bggUrl(g.name)} target="_blank" rel="noreferrer"
                style={{fontSize:12,color:T.amber,textDecoration:"none",fontWeight:500}}>🎲 BGG →</a>
              <button onClick={()=>doToggleLike(g.id)}
                style={{background:liked?T.copperSoft:"transparent",border:`2px solid ${liked?T.copper:T.border2}`,
                  borderRadius:4,padding:"5px 12px",fontSize:12,color:liked?T.copper:T.muted,
                  cursor:"pointer",display:"inline-flex",alignItems:"center",gap:5,
                  transition:"all .15s",fontFamily:"'Cinzel',serif",fontWeight:700}}>
                <i className="ti ti-heart" style={{fontSize:13}}/>{g.likes?.length||0}
              </button>
            </div>
          </Card>;
        })}
      </div>
    </>}
  </div>;
}

// ── Provisions / Galley ───────────────────────────────────────────────────────
function Provisions({ctx}){
  const {food,supplies,voyageMenu,users,authUser,doSaveFood,doDelFood,doSaveSupply,doDelSupply,doSaveMenuItem,doDelMenuItem,showToast}=ctx;
  const [tab,setTab]=useState("food");
  const [showAdd,setShowAdd]=useState(false);
  const [iname,setIname]=useState(""); const [icat,setIcat]=useState(FOOD_CATS[0]);
  const [iserves,setIserves]=useState(""); const [inotes,setInotes]=useState("");
  const [expanded,setExpanded]=useState({});

  const isFood=tab==="food";
  const items=isFood?Object.values(food):Object.values(supplies);
  const CATS=isFood?FOOD_CATS:SUPP_CATS;
  const accent=isFood?T.amber:T.copper;
  const chipCol=isFood?"amber":"copper";

  const switchTab=t=>{ setTab(t); setShowAdd(false); setIname(""); setInotes(""); setIserves(""); setIcat(t==="food"?FOOD_CATS[0]:SUPP_CATS[0]); };

  const save=async()=>{
    if(!iname.trim())return;
    const item={id:uid(),name:iname.trim(),category:icat,notes:inotes.trim(),ownerId:authUser.uid,...(isFood?{serves:iserves}:{})};
    if(isFood){await doSaveFood(item);showToast("Provision stowed! 🍲");}
    else{await doSaveSupply(item);showToast("Gear loaded! ⚙️");}
    setIname(""); setInotes(""); setIserves(""); setShowAdd(false);
  };

  const myItems=items.filter(i=>i.ownerId===authUser?.uid);
  const byUser=Object.values(users)
    .filter(u=>u.id!==authUser?.uid)
    .map(u=>({user:u,items:items.filter(i=>i.ownerId===u.id)}))
    .filter(g=>g.items.length>0);

  return (
    <div className="cc-fade">
      <SectionTitle sub="Coordinate food and gear for the voyage">The Galley</SectionTitle>

      {/* Sub-tabs */}
      <div style={{display:"flex",gap:6,marginBottom:20,flexWrap:"wrap"}}>
        {[
          ["food",    "🍲 Provisions",   Object.values(food).length],
          ["supplies","⚙️ Gear",          Object.values(supplies).length],
          ["menu",    "🍽️ Voyage Menu",   Object.values(voyageMenu).length],
        ].map(([id,label,count])=>{
          const isActive=tab===id;
          const col=id==="menu"?T.steam:id==="supplies"?T.copper:T.amber;
          const colSoft=id==="menu"?T.steamSoft:id==="supplies"?T.copperSoft:T.amberSoft;
          return (
            <button key={id} onClick={()=>switchTab(id)}
              style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"6px 13px",borderRadius:5,cursor:"pointer",
                border:`1.5px solid ${isActive?col:T.border}`,background:isActive?colSoft:"transparent",
                color:isActive?col:T.muted,transition:"all .15s",display:"flex",alignItems:"center",gap:5}}>
              {label}
              <span style={{background:isActive?"rgba(200,144,42,.15)":"transparent",color:isActive?col:T.hint,
                borderRadius:4,padding:"1px 6px",fontSize:10,border:`1px solid ${isActive?col:T.border}`}}>
                {count}
              </span>
            </button>
          );
        })}
      </div>

      {/* Food / Supplies view */}
      {tab!=="menu" && (
        <>
          {/* Add form */}
          <Card style={{marginBottom:20,border:`1.5px solid ${showAdd?accent+"55":T.border}`,transition:"border .2s",background:T.bgMid}}>
            {!showAdd
              ? <button onClick={()=>setShowAdd(true)}
                  style={{width:"100%",background:"none",border:"none",cursor:"pointer",display:"flex",alignItems:"center",gap:8,
                    color:accent,fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,letterSpacing:".04em"}}>
                  <i className="ti ti-plus" style={{fontSize:16}}/> Stow {isFood?"a provision":"some gear"}
                </button>
              : <>
                  <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:accent,marginBottom:14,letterSpacing:".04em"}}>
                    {isFood?"🍲 Stow a Provision":"⚙️ Load Gear"}
                  </h3>
                  <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12,marginBottom:12}}>
                    <Inp label={isFood?"Dish / drink *":"Item name *"}
                      placeholder={isFood?"e.g. Beef stew":"e.g. Camp stove"}
                      value={iname} onChange={e=>setIname(e.target.value)} containerStyle={{gridColumn:"1/-1"}}/>
                    <Sel label="Category" value={icat} onChange={e=>setIcat(e.target.value)}>
                      {CATS.map(c=><option key={c}>{c}</option>)}
                    </Sel>
                    {isFood && <Inp label="Serves (approx.)" placeholder="e.g. 6–8" value={iserves} onChange={e=>setIserves(e.target.value)}/>}
                    <Inp label={isFood?"Allergens / notes":"Brand, quantity…"} placeholder="Optional"
                      value={inotes} onChange={e=>setInotes(e.target.value)}
                      containerStyle={{gridColumn:isFood?"1/-1":"2/3"}}/>
                  </div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    <Btn variant="ghost" onClick={()=>setShowAdd(false)} size="sm">Cancel</Btn>
                    <Btn onClick={save} disabled={!iname.trim()} size="sm" style={{background:accent,color:"#111827"}}>Stow</Btn>
                  </div>
                </>
            }
          </Card>

          {/* My items */}
          <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.text,marginBottom:11,letterSpacing:".03em"}}>
            My manifest{" "}
            {myItems.length>0 && <span style={{fontSize:11,color:T.hint,fontWeight:400}}>({myItems.length})</span>}
          </h3>
          {myItems.length===0
            ? <div style={{background:T.surface2,borderRadius:8,border:`1.5px dashed ${T.border}`,padding:"20px",
                textAlign:"center",color:T.hint,marginBottom:18}}>
                <p style={{fontSize:13,fontFamily:"'Cinzel',serif"}}>{isFood?"Nothing stowed yet.":"No gear loaded."}</p>
              </div>
            : <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:20}}>
                {myItems.map(item=>(
                  <div key={item.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",
                    background:T.surface,border:`1px solid ${T.border}`,borderRadius:8}}>
                    <div style={{flex:1}}>
                      <div style={{fontWeight:500,color:T.text,fontSize:13}}>{item.name}</div>
                      <div style={{display:"flex",gap:6,marginTop:4,flexWrap:"wrap",alignItems:"center"}}>
                        <Chip color={chipCol}>{item.category}</Chip>
                        {item.serves && <span style={{fontSize:11,color:T.hint}}>Serves {item.serves}</span>}
                        {item.notes  && <span style={{fontSize:11,color:T.hint}}>{item.notes}</span>}
                      </div>
                    </div>
                    <button onClick={()=>isFood?doDelFood(item.id):doDelSupply(item.id)}
                      style={{background:T.dangerBg,border:`1px solid ${T.danger}44`,borderRadius:4,
                        cursor:"pointer",color:T.danger,fontSize:13,padding:"4px 7px"}}>
                      <i className="ti ti-trash"/>
                    </button>
                  </div>
                ))}
              </div>
          }

          {/* Crew manifest */}
          <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.text,marginBottom:11,letterSpacing:".03em"}}>
            Crew manifest{" "}
            {items.filter(i=>i.ownerId!==authUser?.uid).length>0 &&
              <span style={{fontSize:11,color:T.hint,fontWeight:400}}>
                ({items.filter(i=>i.ownerId!==authUser?.uid).length} items)
              </span>}
          </h3>
          {byUser.length===0
            ? <div style={{background:T.surface2,borderRadius:8,border:`1.5px dashed ${T.border}`,padding:"20px",
                textAlign:"center",color:T.hint,fontSize:13,fontFamily:"'Cinzel',serif"}}>
                Awaiting crew manifests
              </div>
            : byUser.map(({user,items:ui})=>{
                const open=expanded[user.id]!==false;
                return (
                  <div key={user.id} style={{borderRadius:8,border:`1px solid ${T.border}`,overflow:"hidden",marginBottom:10}}>
                    <div onClick={()=>setExpanded(p=>({...p,[user.id]:!open}))}
                      style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",background:T.surface2,cursor:"pointer",userSelect:"none"}}>
                      <Avatar name={user.name} picture={user.picture} size={52}/>
                      <div style={{flex:1}}>
                        <div style={{fontWeight:500,fontSize:13,color:T.text}}>{user.name}</div>
                        {user.dietary?.length>0 && <div style={{fontSize:11,color:T.hint}}>{user.dietary.join(", ")}</div>}
                      </div>
                      <span style={{fontSize:11,color:T.hint,marginRight:6}}>{ui.length} item{ui.length!==1?"s":""}</span>
                      <i className={`ti ${open?"ti-chevron-up":"ti-chevron-down"}`} style={{fontSize:13,color:T.amber}}/>
                    </div>
                    {open && (
                      <div style={{padding:"10px 12px",display:"flex",flexDirection:"column",gap:7,background:T.bg}}>
                        {ui.map(item=>(
                          <div key={item.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",
                            background:T.surface,borderRadius:6,border:`1px solid ${T.border}`}}>
                            <div style={{flex:1}}>
                              <div style={{fontWeight:500,fontSize:13,color:T.text}}>{item.name}</div>
                              <div style={{display:"flex",gap:5,marginTop:3,flexWrap:"wrap"}}>
                                <Chip color={chipCol}>{item.category}</Chip>
                                {item.serves && <span style={{fontSize:11,color:T.hint}}>Serves {item.serves}</span>}
                                {item.notes  && <span style={{fontSize:11,color:T.hint}}>{item.notes}</span>}
                              </div>
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })
          }
        </>
      )}

      {/* Voyage Menu view */}
      {tab==="menu" && (
        <VoyageMenu
          voyageMenu={voyageMenu}
          users={users}
          authUser={authUser}
          doSaveMenuItem={doSaveMenuItem}
          doDelMenuItem={doDelMenuItem}
        />
      )}
    </div>
  );
}


// ── Voyage Menu ───────────────────────────────────────────────────────────────
const MENU_MEALS = ["Breakfast","Lunch","Dinner"];

function VoyageMenu({voyageMenu,users,authUser,doSaveMenuItem,doDelMenuItem}){
  const [activeDay,setActiveDay]=useState("Nov 26");
  const [showAddFor,setShowAddFor]=useState(null); // "Nov 26|Breakfast"
  const [newDish,setNewDish]=useState(""); const [newNotes,setNewNotes]=useState("");

  const itemsForDayMeal=(day,meal)=>Object.values(voyageMenu).filter(m=>m.day===day&&m.meal===meal);

  const save=async()=>{
    if(!newDish.trim()||!showAddFor)return;
    const [day,meal]=showAddFor.split("|");
    await doSaveMenuItem({id:uid(),day,meal,dish:newDish.trim(),notes:newNotes.trim(),ownerId:authUser.uid,ownerName:""});
    setNewDish("");setNewNotes("");setShowAddFor(null);
  };

  return <div>
    <div style={{marginBottom:14,display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
      <span style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,fontWeight:700,letterSpacing:".04em"}}><i className="ti ti-chef-hat"/> Voyage Menu</span>
      <span style={{fontSize:11,color:T.hint}}>— What's cooking each day?</span>
    </div>

    {/* Day tabs */}
    <div style={{display:"flex",gap:6,marginBottom:16,flexWrap:"wrap"}}>
      {COTTAGE_DAYS.map(d=>(
        <button key={d.short} onClick={()=>{setActiveDay(d.short);setShowAddFor(null);}}
          style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"5px 12px",borderRadius:4,border:`1px solid ${activeDay===d.short?T.steam:T.border}`,cursor:"pointer",background:activeDay===d.short?T.steamSoft:"transparent",color:activeDay===d.short?T.steam:T.muted,transition:"all .15s"}}>
          {d.icon} {d.short}
        </button>
      ))}
    </div>

    <div style={{display:"flex",flexDirection:"column",gap:14}}>
      {MENU_MEALS.map(meal=>{
        const mealItems=itemsForDayMeal(activeDay,meal);
        const key=`${activeDay}|${meal}`;
        const isAdding=showAddFor===key;
        const mealIcon=meal==="Breakfast"?"🍳":meal==="Lunch"?"🥗":"🍲";
        return <Card key={meal} style={{background:T.bgMid,border:`1px solid ${isAdding?T.steam+"55":T.border}`}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
            <h4 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.steam,letterSpacing:".04em"}}>{mealIcon} {meal}</h4>
            {!isAdding&&<button onClick={()=>{setShowAddFor(key);setNewDish("");setNewNotes("");}}
              style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"4px 10px",borderRadius:4,border:`1px solid ${T.steam}`,background:T.steamSoft,color:T.steam,cursor:"pointer"}}>
              + Add dish
            </button>}
          </div>
          {/* Dishes list */}
          {mealItems.length===0&&!isAdding&&<p style={{fontSize:12,color:T.hint,fontStyle:"italic"}}>No dishes added yet — claim a slot!</p>}
          <div style={{display:"flex",flexDirection:"column",gap:7}}>
            {mealItems.map(item=>{
              const owner=users[item.ownerId];
              const isMine=item.ownerId===authUser?.uid;
              return <div key={item.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 10px",background:T.surface,borderRadius:6,border:`1px solid ${T.border}`}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:13,fontWeight:500,color:T.text}}>{item.dish}</div>
                  <div style={{display:"flex",gap:8,alignItems:"center",marginTop:3,flexWrap:"wrap"}}>
                    {owner&&<div style={{display:"flex",alignItems:"center",gap:4}}><Avatar name={owner.name} picture={owner.picture} size={28}/><span style={{fontSize:11,color:T.hint}}>{isMine?"You":owner.name}</span></div>}
                    {item.notes&&<span style={{fontSize:11,color:T.hint}}>· {item.notes}</span>}
                  </div>
                </div>
                {isMine&&<button onClick={()=>doDelMenuItem(item.id)} style={{background:T.dangerBg,border:`1px solid ${T.danger}44`,borderRadius:4,cursor:"pointer",color:T.danger,fontSize:12,padding:"3px 6px"}}><i className="ti ti-trash"/></button>}
              </div>;
            })}
          </div>
          {/* Add form */}
          {isAdding&&<div style={{marginTop:10,display:"flex",flexDirection:"column",gap:8,padding:"10px",background:T.surface2,borderRadius:6,border:`1px solid ${T.steam}44`}}>
            <Inp label="Dish name *" placeholder={`e.g. ${meal==="Breakfast"?"Scrambled eggs & toast":meal==="Lunch"?"Soup & sandwiches":"Beef stew"}`} value={newDish} onChange={e=>setNewDish(e.target.value)}/>
            <Inp label="Notes (serves, allergens…)" placeholder="Optional" value={newNotes} onChange={e=>setNewNotes(e.target.value)}/>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>setShowAddFor(null)} style={{fontFamily:"'Cinzel',serif",fontSize:11,padding:"5px 12px",borderRadius:4,border:`1px solid ${T.border}`,background:"transparent",color:T.muted,cursor:"pointer"}}>Cancel</button>
              <button onClick={save} disabled={!newDish.trim()} style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"5px 12px",borderRadius:4,border:`1px solid ${T.steam}`,background:T.steamSoft,color:T.steam,cursor:"pointer",opacity:newDish.trim()?1:.5}}>Add to Menu</button>
            </div>
          </div>}
        </Card>;
      })}
    </div>
  </div>;
}

// ── Personal Log ─────────────────────────────────────────────────────────────
export function CaptainsLog({ctx}){
  const {profile,authUser,games,users,food,supplies,deckHands,doUpdateProfile,doLogout,notifPerm,notifSupported,requestPermission,doLogGamePlayed,doRemoveGamePlayed,showToast}=ctx;
  const [name,setName]=useState(profile?.name||"");
  const [diet,setDiet]=useState(profile?.dietary||[]);
  const [rank,setRank]=useState(profile?.crewRank||"Enlisted");
  const [pic,setPic]=useState(profile?.picture||"");
  const [saving,setSaving]=useState(false);
  const {pickImage,imgErr,Input:ImgInput}=useImageUpload();

  const uid = profile?.id;

  // My data derived from ctx
  const myGames    = Object.values(games||{}).filter(g=>g.ownerId===uid&&!g.isRequest);
  const myRequests = Object.values(games||{}).filter(g=>g.ownerId===uid&&g.isRequest);
  const myFood     = Object.values(food||{}).filter(f=>f.ownerId===uid);
  const mySupplies = Object.values(supplies||{}).filter(s=>s.ownerId===uid);
  const mySlots    = Object.values(deckHands||{}).filter(s=>s.claimedBy===uid);

  const save=async()=>{
    setSaving(true);
    await doUpdateProfile({...profile,name:name.trim()||profile.name,dietary:diet,picture:pic,crewRank:rank});
    setSaving(false);
  };

  const SectionRow = ({emoji,label,items,color=T.amber,emptyMsg}) => (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:8}}>
        <span style={{fontSize:16}}>{emoji}</span>
        <span style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,color,textTransform:"uppercase",letterSpacing:".06em"}}>{label}</span>
        <span style={{fontSize:11,color:T.hint}}>({items.length})</span>
      </div>
      {items.length===0
        ? <p style={{fontSize:12,color:T.hint,fontStyle:"italic",paddingLeft:22}}>{emptyMsg}</p>
        : <div style={{display:"flex",flexDirection:"column",gap:6,paddingLeft:4}}>
            {items.map((item,i)=>(
              <div key={i} style={{display:"flex",alignItems:"center",gap:8,padding:"7px 10px",background:T.surface2,borderRadius:6,border:`1px solid ${T.border}`}}>
                {item.icon&&<span style={{fontSize:14}}>{item.icon}</span>}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontSize:13,fontWeight:500,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.name}</div>
                  {item.sub&&<div style={{fontSize:11,color:T.hint,marginTop:1}}>{item.sub}</div>}
                </div>
                {item.badge&&<span style={{fontSize:10,padding:"2px 7px",borderRadius:3,background:item.badgeBg||T.amberSoft,color:item.badgeColor||T.amber,border:`1px solid ${item.badgeBorder||T.border2}`,fontFamily:"'Cinzel',serif",fontWeight:700,flexShrink:0}}>{item.badge}</span>}
              </div>
            ))}
          </div>
      }
    </div>
  );

  return <div className="cc-fade">
    <SectionTitle sub="Your crew record and personal preferences">Personal Log</SectionTitle>

    {/* ── Secret role briefing (sealed until unlocked) ── */}
    <NarrativeDossier ctx={ctx}/>

    {/* ── Profile edit card ── */}
    <Card style={{background:T.bgMid,border:`1px solid ${T.border2}`,marginBottom:18}}>
      <div style={{textAlign:"center",marginBottom:20}}>
        <ImgInput/>
        <div onClick={()=>pickImage(setPic)}
          style={{width:92,height:92,borderRadius:"50%",background:pic?`url(${pic}) center/cover`:T.surface2,margin:"0 auto 8px",cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",border:`2px solid ${T.amber}`,fontSize:32,overflow:"hidden",boxShadow:`0 0 16px ${T.amber}33`}}>
          {!pic&&"🧑"}
        </div>
        <div style={{fontSize:11,color:T.hint}}>Click to change portrait (max 800 KB)</div>
        {imgErr&&<div style={{fontSize:12,color:T.danger,marginTop:6,padding:"7px 12px",background:T.dangerBg,borderRadius:6,border:`1px solid ${T.danger}44`,lineHeight:1.4,textAlign:"left"}}>{imgErr}</div>}
      </div>
      <BrassRule/>
      <div style={{display:"flex",flexDirection:"column",gap:14,marginTop:14}}>
        <Inp label="Display name" value={name} onChange={e=>setName(e.target.value)}/>
        <div style={{fontSize:12,color:T.hint,background:T.surface2,padding:"8px 12px",borderRadius:6,display:"flex",alignItems:"center",gap:6,border:`1px solid ${T.border}`}}>
          <i className="ti ti-mail" style={{fontSize:13,color:T.amber}}/> {profile?.email}
        </div>
        {/* Deposit status — read-only */}
        <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 14px",
          background:profile?.deposit?T.amberSoft:T.surface2,
          border:`2px solid ${profile?.deposit?T.amber:T.border2}`,borderRadius:6}}>
          <span style={{fontSize:24}}>💰</span>
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,color:profile?.deposit?T.amberGlow:T.muted}}>
              Deposit
            </div>
            <div style={{fontSize:11,color:profile?.deposit?T.amberGlow:T.hint}}>
              {profile?.deposit?"Received — thank you! ✓":"Pending — contact the organiser"}
            </div>
          </div>
          <span style={{fontSize:11,padding:"3px 10px",borderRadius:4,fontFamily:"'Cinzel',serif",fontWeight:700,
            background:profile?.deposit?T.amberSoft:T.surface3,color:profile?.deposit?T.amberGlow:T.hint}}>
            {profile?.deposit?"PAID":"PENDING"}
          </span>
        </div>
        {profile?.lastLogin&&<div style={{background:T.surface2,border:`1px solid ${T.border}`,borderRadius:6,overflow:"hidden"}}>
          <div style={{padding:"8px 12px",borderBottom:`1px solid ${T.border}`,display:"flex",alignItems:"center",gap:6}}>
            <i className="ti ti-clock" style={{fontSize:13,color:T.amber}}/>
            <span style={{fontSize:12,color:T.hint}}>Last login: </span>
            <span style={{fontSize:12,color:T.muted,fontWeight:500}}>{new Date(profile.lastLogin).toLocaleString("en-CA",{month:"short",day:"numeric",year:"numeric",hour:"2-digit",minute:"2-digit"})}</span>
          </div>
          {profile?.lastDevice&&<div style={{padding:"8px 12px",display:"flex",gap:12,flexWrap:"wrap"}}>
            {[
              {icon:"ti-device-laptop",val:profile.lastDevice.deviceType},
              {icon:"ti-brand-windows",val:profile.lastDevice.os},
              {icon:"ti-browser",     val:profile.lastDevice.browser},
            ].map(({icon,val})=>(
              <div key={icon} style={{display:"flex",alignItems:"center",gap:4}}>
                <i className={`ti ${icon}`} style={{fontSize:12,color:T.amber}}/>
                <span style={{fontSize:11,color:T.hint}}>{val}</span>
              </div>
            ))}
          </div>}
        </div>}
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:8}}>Crew Rank</span>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            {Object.entries(CREW_RANKS).map(([r,rc])=>{const active=rank===r;return(
              <button key={r} onClick={()=>setRank(r)} style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"7px 16px",borderRadius:5,cursor:"pointer",border:`2px solid ${active?rc.border:T.border}`,background:active?rc.bg:"transparent",color:active?rc.text:T.muted,transition:"all .15s",display:"inline-flex",alignItems:"center",gap:5,boxShadow:active?`0 0 10px ${rc.glow}55`:undefined}}>
                <span style={{fontSize:16}}>{rc.icon}</span>
                <span>{r}</span>
              </button>);})}
          </div>
        </div>
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:8}}>Dietary orders</span>
          <DietPills selected={diet} onToggle={d=>setDiet(p=>p.includes(d)?p.filter(x=>x!==d):[...p,d])}/>
        </div>
        <BrassRule/>
        <Btn onClick={save} disabled={saving} style={{width:"100%",fontSize:14}}>
          {saving?"Recording…":"⚙️ Update Ship's Log"}
        </Btn>
        <Btn variant="ghost" onClick={doLogout} style={{width:"100%",color:T.muted,fontSize:13}}>
          <i className="ti ti-logout"/> Disembark
        </Btn>
      </div>
    </Card>

    {/* ── Push notifications opt-in ── */}
    {notifSupported&&notifPerm!=="granted"&&<Card style={{background:T.bgMid,border:`2px solid ${T.steam}55`,marginBottom:18}}>
      <div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <div style={{fontSize:28,flexShrink:0}}>🔔</div>
        <div style={{flex:1}}>
          <div style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.steam,fontWeight:700,marginBottom:3}}>Stay in the loop</div>
          <div style={{fontSize:12,color:T.muted}}>Enable notifications to get updates when crew add games, sign up for duties, or the itinerary changes.</div>
        </div>
        <button onClick={requestPermission}
          style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"7px 16px",borderRadius:5,
            border:`2px solid ${T.steam}`,background:T.steamSoft,color:T.steam,cursor:"pointer",flexShrink:0,
            boxShadow:`0 0 10px ${T.steam}33`}}>
          {notifPerm==="denied"?"Blocked in settings":"Enable"}
        </button>
      </div>
      {notifPerm==="denied"&&<p style={{fontSize:11,color:T.hint,marginTop:8,fontStyle:"italic"}}>
        Notifications are blocked. To enable, tap the lock icon in your browser's address bar and allow notifications.
      </p>}
    </Card>}
    {notifSupported&&notifPerm==="granted"&&<Card style={{background:T.bgMid,border:`2px solid #4ADE8055`,marginBottom:18}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,flexWrap:"wrap"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <span style={{fontSize:22}}>🔔</span>
          <div>
            <div style={{fontFamily:"'Cinzel',serif",fontSize:12,color:"#4ADE80",fontWeight:700}}>Notifications enabled</div>
            <div style={{fontSize:11,color:T.hint}}>
              {profile?.fcmToken
                ? `Token registered ✓`
                : "Token not yet registered — tap Refresh"}
            </div>
          </div>
        </div>
        <button onClick={requestPermission}
          style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"5px 12px",borderRadius:4,
            border:`1.5px solid #4ADE80`,background:"#162A1E",color:"#4ADE80",cursor:"pointer",flexShrink:0}}>
          ↻ Refresh Token
        </button>
      </div>
      {profile?.fcmToken&&<div style={{marginTop:8,padding:"6px 10px",background:T.surface,borderRadius:4,border:`1px solid ${T.border}`}}>
        <div style={{fontSize:10,color:T.hint,marginBottom:2,fontFamily:"'Cinzel',serif",letterSpacing:".04em"}}>FCM TOKEN</div>
        <div style={{fontSize:10,color:T.muted,wordBreak:"break-all",fontFamily:"monospace",lineHeight:1.4}}>
          {profile.fcmToken}
        </div>
      </div>}
    </Card>}

    {/* ── My contributions ── */}
    <Card style={{background:T.bgMid,border:`1px solid ${T.border2}`}}>
      <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber,marginBottom:18,letterSpacing:".05em"}}>
        📋 My Contributions
      </h3>
      <div style={{display:"flex",flexDirection:"column",gap:20}}>

        {/* Deck hand assignments */}
        <SectionRow emoji="⚙️" label="Duty Assignments" color={T.steam}
          emptyMsg="No duties signed up yet — head to Deck Hands."
          items={mySlots.map(s=>({
            name: s.task,
            sub:  s.day,
            badge: s.type==="prep"?"⚙️ Prep":"🧹 Cleanup",
            badgeBg: s.type==="prep"?T.steamSoft:T.copperSoft,
            badgeColor: s.type==="prep"?T.steam:T.copper,
            badgeBorder: s.type==="prep"?T.steam+"44":T.copper+"44",
          }))}
        />

        <BrassRule/>

        {/* Games */}
        <SectionRow emoji="🎲" label="My Games" color={T.amber}
          emptyMsg="No games loaded — visit the Cargo Hold."
          items={myGames.map(g=>{
            const cc=g.category?GAME_CAT_COLORS[g.category]:null;
            return {
              name: g.name,
              sub: [g.minPlayers&&`${g.minPlayers}${g.maxPlayers&&g.maxPlayers!==g.minPlayers?`–${g.maxPlayers}`:""} players`,g.category].filter(Boolean).join(" · "),
              badge: cc?`${cc.icon} ${g.category}`:null,
              badgeBg: cc?.bg,badgeColor:cc?.text,badgeBorder:cc?.border,
            };
          })}
        />

        {/* Games Played during the trip */}
        <BrassRule/>
        <GamesPlayedLogger
          authUser={authUser}
          profile={profile}
          games={Object.values(games||{})}
          doLogGamePlayed={doLogGamePlayed}
          doRemoveGamePlayed={doRemoveGamePlayed}
          showToast={showToast}
        />
        <BrassRule/>

        {/* Game requests */}
        {myRequests.length>0&&<SectionRow emoji="📜" label="My Requests" color={T.copper}
          emptyMsg=""
          items={myRequests.map(g=>({name:g.name,sub:g.notes||"Requested game",badge:"Requested",badgeBg:T.copperSoft,badgeColor:T.copper,badgeBorder:T.copper+"44"}))}
        />}

        <BrassRule/>

        {/* Galley */}
        <SectionRow emoji="🍲" label="Galley Provisions" color="#4ADE80"
          emptyMsg="Nothing stowed yet — visit the Galley."
          items={myFood.map(f=>({name:f.name,sub:[f.category,f.serves?`Serves ${f.serves}`:"",f.notes].filter(Boolean).join(" · ")}))}
        />

        {/* Gear */}
        <SectionRow emoji="⚙️" label="Gear & Supplies" color={T.muted}
          emptyMsg="No gear loaded — visit the Galley."
          items={mySupplies.map(s=>({name:s.name,sub:[s.category,s.notes].filter(Boolean).join(" · ")}))}
        />

      </div>
    </Card>
  </div>;
}


// ── Itinerary ─────────────────────────────────────────────────────────────────
export const COTTAGE_DAYS = [
  { date:"Thursday, Nov 26",  short:"Nov 26", label:"Arrival Day",    icon:"⚓" },
  { date:"Friday, Nov 27",    short:"Nov 27", label:"Full Day",       icon:"⚙️" },
  { date:"Saturday, Nov 28",  short:"Nov 28", label:"Full Day",       icon:"🎲" },
  { date:"Sunday, Nov 29",    short:"Nov 29", label:"Departure Day",  icon:"🚀" },
];

// Default activity chips per base day (fallback when Engine Room hasn't set any yet)
export const DEFAULT_ACTIVITIES = {
  "Nov 26": ["🚂 Arrivals — Thursday","🎲 Evening games","🍺 Welcome drinks"],
  "Nov 27": ["☀️ Full day","🎲 All-day gaming","🍽️ Group dinner"],
  "Nov 28": ["☀️ Full day","🏆 Tournament day","🎉 Game night"],
  "Nov 29": ["🧹 Pack & clean by 11 AM","👋 Departures — Sunday"],
};

// A saved itinerary doc overrides a base day when its short label OR its stable id matches.
// (The id stays fixed when the Engine Room renames the short label, so match on both.)
const isBaseDayDoc = d => COTTAGE_DAYS.some(b => b.short === d.short || b.short.replace(/\s+/g,'_') === d.id);

export function Itinerary({ctx}){
  const {itinerary, itinMeta} = ctx;

  // Merge Firestore overrides onto the static base days
  // Re-compute whenever itinerary Firestore data changes
  const saved = Object.values(itinerary || {});
  const liveDays = COTTAGE_DAYS.map(base => {
    // Match by short label OR by the id we'd have generated (short with spaces→underscores)
    const stableId = base.short.replace(/\s+/g, '_');
    const override = saved.find(x => x.short === base.short || x.id === stableId);
    if (override) {
      return {
        ...base,
        ...override,
        activities: override.activities?.length ? override.activities : DEFAULT_ACTIVITIES[base.short] || [],
      };
    }
    return { ...base, activities: DEFAULT_ACTIVITIES[base.short] || [] };
  });

  // Append any extra days added via Engine Room
  const extraDays = saved
    .filter(d => !isBaseDayDoc(d))
    .sort((a,b) => (a.date||"").localeCompare(b.date||""));

  const allDays = [...liveDays, ...extraDays];

  return <div className="cc-fade">
    <SectionTitle sub="Yellow Cottage · Nov 26–29, 2026">Voyage Itinerary</SectionTitle>

    {/* Location card */}
    <Card style={{background:T.bgMid,border:`1px solid ${T.border2}`,marginBottom:20}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:16,flexWrap:"wrap"}}>
        <div style={{fontSize:48,lineHeight:1}}>🏡</div>
        <div style={{flex:1,minWidth:200}}>
          <h3 style={{fontFamily:"'Cinzel',serif",fontSize:16,color:T.amber,marginBottom:6,letterSpacing:".04em"}}>The Yellow Cottage</h3>
          <p style={{fontSize:13,color:T.text,marginBottom:4}}>6326 Line 13, Alliston, ON L9R 1V4</p>
          <a href="https://www.google.com/maps/search/6326+Line+13+Alliston+ON+L9R+1V4"
            target="_blank" rel="noreferrer"
            style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:13,color:T.amber,textDecoration:"none",border:`1px solid ${T.border2}`,borderRadius:5,padding:"5px 12px",background:T.amberSoft,fontFamily:"'Cinzel',serif",fontWeight:600,marginTop:4}}>
            <i className="ti ti-map-pin" style={{fontSize:14}}/> Open in Maps
          </a>
        </div>
        <div style={{background:T.surface2,border:`1px solid ${T.border}`,borderRadius:8,padding:"12px 18px",textAlign:"center",minWidth:140}}>
          <div style={{fontSize:11,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4}}>Voyage Dates</div>
          <div style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.amber,fontWeight:700}}>Nov 26–29</div>
          <div style={{fontSize:11,color:T.hint,marginTop:2}}>4 days · 3 nights</div>
        </div>
      </div>
    </Card>

    {/* Map embed */}
    <Card style={{background:T.bgMid,marginBottom:20,padding:0,overflow:"hidden"}}>
      <div style={{position:"relative",paddingTop:"40%",minHeight:220}}>
        <iframe
          title="Cottage Location"
          src="https://maps.google.com/maps?q=6326+Line+13,+Alliston,+ON+L9R+1V4&output=embed&z=13"
          style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",border:"none",filter:"sepia(60%) saturate(60%) brightness(0.7)"}}
          loading="lazy"
        />
        <div style={{position:"absolute",inset:0,border:`1.5px solid ${T.border2}`,borderRadius:10,pointerEvents:"none"}}/>
      </div>
    </Card>

    {/* Day-by-day timeline — driven by live Firestore data */}
    <h3 style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.amber,marginBottom:14,letterSpacing:".04em"}}>
      <i className="ti ti-calendar" style={{marginRight:6}}/>Voyage Timeline
    </h3>
    <div style={{display:"flex",flexDirection:"column",gap:0}}>
      {allDays.map((day,i)=>(
        <div key={day.short||i} style={{display:"flex",gap:0}}>
          {/* Timeline spine */}
          <div style={{display:"flex",flexDirection:"column",alignItems:"center",width:40,flexShrink:0}}>
            <div style={{width:32,height:32,borderRadius:"50%",background:T.amberSoft,border:`2px solid ${T.amber}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:16,flexShrink:0,zIndex:1}}>
              {day.icon||"📅"}
            </div>
            {i<allDays.length-1&&<div style={{width:2,flex:1,background:`linear-gradient(${T.amber},${T.border})`,minHeight:32}}/>}
          </div>
          {/* Content */}
          <div style={{flex:1,paddingLeft:14,paddingBottom:i<allDays.length-1?24:0}}>
            <div style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber,fontWeight:700,marginBottom:2}}>{day.date}</div>
            <div style={{display:"flex",alignItems:"center",gap:6,marginBottom:6,flexWrap:"wrap"}}>
              <span style={{fontSize:12,color:T.muted}}>{day.label}</span>
              {!COTTAGE_DAYS.find(b=>b.short===day.short)&&
                <span style={{fontSize:10,color:T.copper,border:`1px solid ${T.copper}44`,padding:"1px 6px",borderRadius:3,fontFamily:"'Cinzel',serif"}}>CUSTOM</span>}
            </div>
            {day.notes&&<p style={{fontSize:12,color:T.muted,marginBottom:6,fontStyle:"italic"}}>{day.notes}</p>}
            {day.activities?.length>0&&(
              <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
                {day.activities.map((a,ai)=><Chip key={ai} color="amber">{a}</Chip>)}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>

    {/* Notes — check-in/out from Engine Room itinMeta */}
    <Card style={{background:T.bgMid,marginTop:20,border:`1px solid ${T.border}`}}>
      <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,marginBottom:10,letterSpacing:".04em"}}>⚙️ Notes</h4>
      <div style={{display:"flex",flexDirection:"column",gap:7}}>
        {[
          itinMeta.checkIn&&itinMeta.checkInDay ? `Check in from ${itinMeta.checkIn} on ${itinMeta.checkInDay}` : "Check-in time — set in Engine Room → Itinerary",
          itinMeta.checkOut&&itinMeta.checkOutDay ? `Check out by ${itinMeta.checkOut} on ${itinMeta.checkOutDay}` : "Check-out time — set in Engine Room → Itinerary",
          "All dietary needs listed in crew profiles — coordinate in the Galley",
          itinMeta.parkingNote||"Parking available on site for all crew vehicles",
        ].filter(Boolean).map((note,i)=>(
          <div key={i} style={{display:"flex",gap:8,alignItems:"flex-start"}}>
            <i className="ti ti-point-filled" style={{fontSize:10,color:T.amber,marginTop:4,flexShrink:0}}/>
            <span style={{fontSize:13,color:T.muted}}>{note}</span>
          </div>
        ))}
      </div>
    </Card>
  </div>;
}

// ── Deck Hands ────────────────────────────────────────────────────────────────

function DeckHands({ctx}){
  const {deckHands,users,authUser,profile,doClaimSlot,doUnclaimSlot,doInitDeckHands}=ctx; // users already destructured
  const [initialised,setInitialised]=useState(false);
  const [initing,setIniting]=useState(false);
  const [activeDay,setActiveDay]=useState("Nov 26");

  // Auto-init slots if none exist yet
  useEffect(()=>{
    if(!initialised&&Object.keys(deckHands).length===0&&!initing){
      setIniting(true);
      doInitDeckHands().then(()=>{ setInitialised(true); setIniting(false); });
    } else if(Object.keys(deckHands).length>0) setInitialised(true);
  },[deckHands]);

  const slotsForDay = (day,type) =>
    Object.values(deckHands).filter(s=>s.day===day&&s.type===type)
      .sort((a,b)=>a.task.localeCompare(b.task));

  const mySlots = Object.values(deckHands).filter(s=>s.claimedBy===authUser?.uid);

  if(initing) return <div className="cc-fade"><SectionTitle>Deck Hands</SectionTitle><Spinner label="Preparing the roster…"/></div>;

  const uList = Object.values(users);

  return <div className="cc-fade">
    <SectionTitle sub="Sign up for preparation and cleanup duties each day">Deck Hands</SectionTitle>

    {/* Crew Roster */}
    <Card style={{background:T.bgMid,marginBottom:20,cursor:"default"}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,letterSpacing:".05em"}}>
          <i className="ti ti-users"/> Crew Roster
        </h3>
        <div style={{display:"flex",alignItems:"center",gap:8}}>
          <span style={{fontFamily:"'Cinzel',serif",fontSize:11,color:T.muted,letterSpacing:".04em"}}>ABOARD:</span>
          <div style={{display:"flex",alignItems:"center",justifyContent:"center",minWidth:36,height:36,borderRadius:6,
            background:T.amberSoft,border:`2px solid ${T.border2}`,boxShadow:`0 0 10px ${T.amber}55`}}>
            <span style={{fontFamily:"'Cinzel',serif",fontSize:18,fontWeight:700,color:T.amberGlow,
              textShadow:`0 0 10px ${T.amber}99`,lineHeight:1}}>{uList.length}</span>
          </div>
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {uList.map((u,i)=>{
          const rank=u.crewRank||"Enlisted";
          const rc=CREW_RANKS[rank]||CREW_RANKS["Enlisted"];
          return <div key={u.id} style={{display:"flex",alignItems:"center",gap:10,background:T.surface2,border:`1px solid ${T.border}`,borderRadius:7,padding:"8px 12px"}}>
            <span style={{fontFamily:"'Cinzel',serif",fontSize:11,color:T.hint,width:18,textAlign:"right",flexShrink:0}}>{i+1}.</span>
            <Avatar name={u.name} picture={u.picture} size={56}/>
            <div style={{flex:1,minWidth:0}}>
              <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                <span style={{fontWeight:600,fontSize:13,color:T.text}}>{u.name}</span>
                <span style={{display:"inline-flex",alignItems:"center",gap:3,fontSize:10,padding:"2px 7px",borderRadius:3,
                  background:rc.bg,color:rc.text,border:`1px solid ${rc.border}`,fontFamily:"'Cinzel',serif",
                  fontWeight:700,letterSpacing:".04em",boxShadow:`0 0 6px ${rc.glow}44`,cursor:"help"}}>
                  {rc.icon} {rank}
                </span>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:6,marginTop:3,flexWrap:"wrap"}}>
                {u.dietary?.length>0&&<span style={{fontSize:11,color:T.hint}}>{u.dietary.join(", ")}</span>}
                {/* Games played badges */}
                {(u.gamesPlayed||[]).map(g=>{
                  const gb=gameBadge(g);
                  return <span key={g} title={g} style={{
                    display:"inline-flex",alignItems:"center",justifyContent:"center",
                    width:26,height:26,borderRadius:5,
                    background:gb.bg,color:gb.text,border:`1px solid ${gb.border}`,
                    fontFamily:"'Cinzel',serif",fontSize:9,fontWeight:700,cursor:"help",
                    letterSpacing:"-.02em",flexShrink:0}}>
                    {gb.initials}
                  </span>;
                })}
                {/* Deposit badge — read-only display */}
                <span title={u.deposit?"Deposit received":"Deposit pending"} style={{
                  display:"inline-flex",alignItems:"center",gap:3,fontSize:10,padding:"2px 7px",borderRadius:3,
                  background:u.deposit?T.amberSoft:T.surface3,
                  color:u.deposit?T.amberGlow:T.hint,
                  border:`1px solid ${u.deposit?T.amber:T.border2}`,
                  fontFamily:"'Cinzel',serif",fontWeight:700,letterSpacing:".04em",cursor:"help",
                  boxShadow:u.deposit?`0 0 6px ${T.amber}44`:undefined}}>
                  💰 {u.deposit?"Deposit":"No Deposit"}
                </span>
              </div>
            </div>
          </div>;
        })}
      </div>
    </Card>

    {/* My assignments summary */}
    {mySlots.length>0&&<Card style={{background:T.bgMid,border:`1px solid ${T.amber}55`,marginBottom:20}}>
      <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber,marginBottom:10,letterSpacing:".04em"}}>⚙️ My Duty Assignments</h3>
      <div style={{display:"flex",flexWrap:"wrap",gap:6}}>
        {mySlots.map(s=><div key={s.id} style={{background:T.amberSoft,border:`1px solid ${T.amber}`,borderRadius:5,padding:"4px 10px",fontSize:12,color:T.amber,display:"flex",alignItems:"center",gap:6}}>
          <span style={{fontFamily:"'Cinzel',serif",fontWeight:600}}>{s.day}</span>
          <span style={{color:T.muted}}>·</span>
          <span style={{color:s.type==="prep"?T.steam:T.copper}}>{s.type==="prep"?"⚙️ Prep":"🧹 Clean"}</span>
          <span style={{color:T.muted}}>·</span>
          <span>{s.task}</span>
          <button onClick={()=>doUnclaimSlot(s.id)} style={{background:"none",border:"none",cursor:"pointer",color:T.hint,fontSize:12,padding:"0 2px",marginLeft:2}} title="Unassign">✕</button>
        </div>)}
      </div>
    </Card>}

    {/* Day selector */}
    <div style={{display:"flex",gap:6,marginBottom:18,flexWrap:"wrap"}}>
      {COTTAGE_DAYS.map(d=>(
        <button key={d.short} onClick={()=>setActiveDay(d.short)}
          style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"6px 13px",borderRadius:5,border:`1px solid ${activeDay===d.short?T.amber:T.border}`,cursor:"pointer",background:activeDay===d.short?T.amberSoft:"transparent",color:activeDay===d.short?T.amber:T.muted,transition:"all .15s",display:"flex",alignItems:"center",gap:5}}>
          <span>{d.icon}</span>{d.short}
        </button>
      ))}
    </div>

    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:16}}>
      {/* Preparation */}
      <DeckSection
        title="⚙️ Preparation" color={T.steam}
        slots={slotsForDay(activeDay,"prep")}
        authUser={authUser} profile={profile} users={users}
        onClaim={doClaimSlot} onUnclaim={doUnclaimSlot}
      />
      {/* Cleanup */}
      <DeckSection
        title="🧹 Cleanup" color={T.copper}
        slots={slotsForDay(activeDay,"cleanup")}
        authUser={authUser} profile={profile} users={users}
        onClaim={doClaimSlot} onUnclaim={doUnclaimSlot}
      />
    </div>
  </div>;
}

function DeckSection({title,color,slots,authUser,profile,users,onClaim,onUnclaim}){
  return <Card style={{background:T.bgMid}}>
    <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color,marginBottom:14,letterSpacing:".04em"}}>{title}</h3>
    <div style={{display:"flex",flexDirection:"column",gap:8}}>
      {slots.map(slot=>{
        const claimed   = !!slot.claimedBy;
        const isMine    = slot.claimedBy===authUser?.uid;
        const claimer   = slot.claimedBy ? users[slot.claimedBy] : null;
        return <div key={slot.id} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",background:claimed?T.surface2:T.surface,border:`1px solid ${isMine?color:claimed?T.border:T.border}`,borderRadius:7,transition:"all .2s"}}>
          <div style={{flex:1}}>
            <div style={{fontSize:13,fontWeight:500,color:T.text}}>{slot.task}</div>
            {claimed&&claimer&&<div style={{display:"flex",alignItems:"center",gap:5,marginTop:4}}>
              <Avatar name={claimer.name} picture={claimer.picture} size={32}/>
              <span style={{fontSize:11,color:isMine?color:T.muted}}>{isMine?"You":claimer.name}</span>
            </div>}
            {claimed&&!claimer&&slot.claimedByName&&<div style={{fontSize:11,color:T.muted,marginTop:3}}>{slot.claimedByName}</div>}
          </div>
          {!claimed&&<button onClick={()=>onClaim(slot.id,authUser.uid,profile?.name||"Crew")}
            style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"5px 12px",borderRadius:4,border:`1px solid ${color}`,background:"transparent",color,cursor:"pointer",flexShrink:0,transition:"all .15s"}}>
            Sign Up
          </button>}
          {isMine&&<button onClick={()=>onUnclaim(slot.id)}
            style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"5px 10px",borderRadius:4,border:`1px solid ${T.border}`,background:T.surface,color:T.muted,cursor:"pointer",flexShrink:0,transition:"all .15s"}}>
            Drop
          </button>}
          {claimed&&!isMine&&<div style={{flexShrink:0}}>
            <span style={{fontSize:10,color:T.hint,background:T.surface,border:`1px solid ${T.border}`,borderRadius:4,padding:"3px 8px",fontFamily:"'Cinzel',serif"}}>Assigned</span>
          </div>}
        </div>;
      })}
      {slots.length===0&&<div style={{textAlign:"center",padding:"20px 0",color:T.hint,fontSize:13,fontFamily:"'Cinzel',serif"}}>Loading roster…</div>}
    </div>
  </Card>;
}

// ── Manifest (Receipt Upload) ─────────────────────────────────────────────────
export function Manifest({ctx}){
  const {receipts,users,authUser,profile,doSaveReceipt,doDelReceipt,showToast}=ctx;
  const [uploading,  setUploading]  = useState(false);
  const [scanning,   setScanning]   = useState(false);
  const [imgErr,     setImgErr]     = useState("");
  const [desc,       setDesc]       = useState("");
  const [amount,     setAmount]     = useState("");
  const [aiScanned,  setAiScanned]  = useState(false); // flag when AI filled the amount
  const fileRef   = useRef();
  const cameraRef = useRef();

  const receiptList = Object.values(receipts).sort((a,b)=>(b.createdAt||0)-(a.createdAt||0));

  const openEditReceipt = (r) => {
    setEditReceipt(r);
    setDesc(r.desc||r.description||"");
    setAmount(r.amount||"");
    setAiScanned(false); setImgErr("");
    window.scrollTo({top:0,behavior:"smooth"});
  };
  const cancelEdit = () => { setEditReceipt(null); setDesc(""); setAmount(""); setAiScanned(false); };
  const totalAmount = sumAmount(receiptList);

  // Send image to Gemini and extract total amount + description
  // Returns {amount, desc} so caller doesn't depend on stale React state
  const scanReceiptWithAI = async (base64DataUrl) => {
    setScanning(true);
    setAiScanned(false);
    let result = null;
    try {
      const text = await geminiVision(base64DataUrl,
        "This is a receipt image. Extract the total amount paid and a short 3-5 word description. Reply in EXACTLY this format with nothing else - AMOUNT: <number without currency> DESC: <description>",
        "AI scan failed");
      console.log("[Receipt AI]", text);

      const amountMatch = text.match(/AMOUNT:\s*([\d.,]+)/i);
      const descMatch   = text.match(/DESC:\s*(.+)/i);

      if(amountMatch?.[1]){
        const parsed = parseFloat(amountMatch[1].replace(",",""));
        if(!isNaN(parsed)){
          const amtStr = parsed.toFixed(2);
          setAmount(amtStr);
          setAiScanned(true);
          result = { amount: amtStr };
        }
      }
      if(descMatch?.[1]){
        const d = descMatch[1].trim();
        if(!desc.trim()) setDesc(d);
        result = { ...(result||{}), desc: d };
      }
    } catch(e){
      console.warn("[Receipt AI] scan error:", e.message);
    }
    setScanning(false);
    return result; // caller uses this to avoid stale-state closure problem
  };

  const handleFile = e => {
    const f = e.target.files[0]; if(!f) return;
    // Size checked after compression — reject only truly massive files (> 10 MB raw)
    if(f.size > 10 * 1024 * 1024){
      setImgErr(`Image too large (${(f.size/1024/1024).toFixed(1)} MB). Max 10 MB.`);
      fileRef.current.value=""; return;
    }
    setImgErr("");
    const reader = new FileReader();
    reader.onload = async ev => {
      setUploading(true);
      // Compress before scanning/saving — reduces 3-8 MB phone photos to ~200 KB
      const dataUrl = await compressImage(ev.target.result).catch(()=>ev.target.result);

      // Scan with AI — returns extracted values directly so we don't rely on stale state
      const aiResult = await scanReceiptWithAI(dataUrl);
      const finalAmount = aiResult?.amount || amount.trim();
      const finalDesc   = aiResult?.desc   || desc.trim() || "Receipt";

      await doSaveReceipt({
        id: uid(),
        image: dataUrl,
        desc: finalDesc,
        amount: finalAmount,
        ownerId: authUser.uid,
        ownerName: profile?.name || "Crew",
        createdAt: Date.now(),
      });
      setDesc(""); setAmount(""); setAiScanned(false);
      fileRef.current.value = "";
      setUploading(false);
    };
    reader.readAsDataURL(f);
  };

  const [lightbox,    setLightbox]   = useState(null);
  const [editReceipt, setEditReceipt] = useState(null);

  return (
    <div className="cc-fade">
      <SectionTitle sub="Upload receipts and track shared expenses">Ship's Manifest</SectionTitle>

      {/* Upload card */}
      <Card style={{background:T.bgMid,border:`1px solid ${T.border2}`,marginBottom:22}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
          <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:editReceipt?T.steam:T.amber,letterSpacing:".04em"}}>
            {editReceipt?"✏️ Editing Receipt":"📜 Log a New Receipt"}
          </h3>
          {editReceipt&&<span style={{fontSize:11,color:T.hint,fontStyle:"italic"}}>#{editReceipt.id?.slice(0,6)}</span>}
        </div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12,marginBottom:14}}>
          <Inp
            label="Description"
            placeholder="e.g. Grocery run"
            value={desc}
            onChange={e=>setDesc(e.target.value)}
            containerStyle={{gridColumn:"1/-1"}}
          />
          <div style={{position:"relative"}}>
            <Inp
              label="Amount ($)"
              placeholder="e.g. 42.50"
              type="number"
              step="0.01"
              value={amount}
              onChange={e=>{ setAmount(e.target.value); setAiScanned(false); }}
            />
            {scanning&&<div style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
              fontSize:11,color:T.steam,fontFamily:"'Cinzel',serif",display:"flex",alignItems:"center",gap:4}}>
              <span style={{display:"inline-block",animation:"ccSpin 1s linear infinite"}}>⚙️</span> Scanning…
            </div>}
            {aiScanned&&!scanning&&<div style={{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",
              fontSize:11,color:"#4ADE80",fontFamily:"'Cinzel',serif",display:"flex",alignItems:"center",gap:3}}>
              ✓ AI
            </div>}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:4}}>
            <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em"}}>Receipt image</span>
            {scanning||uploading
              ? <button disabled style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"9px 14px",borderRadius:6,
                  border:`1.5px solid ${T.border2}`,background:T.surface2,color:T.amber,
                  display:"flex",alignItems:"center",gap:6,cursor:"wait",opacity:.7}}>
                  <i className="ti ti-camera-upload" style={{fontSize:15}}/>
                  {scanning?"🤖 Scanning receipt…":"Uploading…"}
                </button>
              : <div style={{display:"flex",gap:6}}>
                  {/* Camera — takes photo directly */}
                  <button onClick={()=>{ setImgErr(""); cameraRef.current.click(); }}
                    style={{flex:1,fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"9px 10px",borderRadius:6,
                      border:`1.5px solid ${T.border2}`,background:T.surface2,color:T.amber,
                      cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5,transition:"all .15s"}}
                    title="Take a photo">
                    <i className="ti ti-camera" style={{fontSize:15}}/> Camera
                  </button>
                  {/* Library — choose from files */}
                  <button onClick={()=>{ setImgErr(""); fileRef.current.click(); }}
                    style={{flex:1,fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"9px 10px",borderRadius:6,
                      border:`1.5px solid ${T.border2}`,background:T.surface2,color:T.amber,
                      cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center",gap:5,transition:"all .15s"}}
                    title="Choose from library">
                    <i className="ti ti-photo" style={{fontSize:15}}/> Library
                  </button>
                </div>}
            {/* Camera input — triggers rear camera on mobile */}
            <input ref={cameraRef} type="file" accept="image/*" capture="environment" style={{display:"none"}} onChange={handleFile}/>
            {/* Library input — file picker, no capture */}
            <input ref={fileRef}   type="file" accept="image/*" style={{display:"none"}} onChange={handleFile}/>
          </div>
        </div>
        {imgErr&&<div style={{fontSize:12,color:T.danger,background:T.dangerBg,padding:"8px 12px",borderRadius:6,border:`1px solid ${T.danger}44`,marginBottom:10,lineHeight:1.4}}>{imgErr}</div>}
        {editReceipt&&<button
          onClick={async()=>{
            await doSaveReceipt({...editReceipt,desc:desc.trim()||editReceipt.desc,amount:amount||editReceipt.amount,updatedAt:Date.now()});
            showToast("Receipt updated! ✏️");
            cancelEdit();
          }}
          style={{width:"100%",fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,padding:"10px",
            borderRadius:6,border:`2px solid ${T.amber}`,background:T.amberSoft,color:T.amber,
            cursor:"pointer",marginBottom:8}}>
          ✏️ Save Changes (keep existing photo)
        </button>}
        {editReceipt&&<button onClick={cancelEdit}
          style={{width:"100%",fontFamily:"'Cinzel',serif",fontSize:12,padding:"8px",
            borderRadius:6,border:`1px solid ${T.border}`,background:"transparent",color:T.hint,
            cursor:"pointer",marginBottom:8}}>
          Cancel Edit
        </button>}
        <div style={{fontSize:12,color:T.hint,fontStyle:"italic"}}>
          💡 {editReceipt?"Update description/amount above, or tap 'Choose Image' to replace the photo.":"Upload a receipt photo and AI will extract the total. You can edit before saving."}
        </div>
      </Card>

      {/* Summary bar */}
      {receiptList.length>0&&<div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 16px",background:T.amberSoft,border:`1px solid ${T.border2}`,borderRadius:8,marginBottom:18}}>
        <span style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,fontWeight:700}}>
          <i className="ti ti-receipt"/> {receiptList.length} receipt{receiptList.length!==1?"s":""} logged
        </span>
        <span style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.amberGlow,fontWeight:700}}>
          Total: ${totalAmount.toFixed(2)}
        </span>
      </div>}

      {/* Receipt grid */}
      {receiptList.length===0
        ?<div style={{textAlign:"center",padding:"48px 0",color:T.hint}}>
          <i className="ti ti-receipt" style={{fontSize:40,display:"block",marginBottom:10,color:T.border2}}/>
          <p style={{fontSize:13,fontFamily:"'Cinzel',serif",color:T.muted}}>No receipts logged yet</p>
          <p style={{fontSize:12,color:T.hint,marginTop:4}}>Upload photos of receipts to track shared expenses</p>
        </div>
        :<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:14}}>
          {receiptList.map(r=>{
            const owner=users[r.ownerId];
            const isOwner=r.ownerId===authUser?.uid;
            return (
              <Card key={r.id} style={{background:T.bgMid,padding:0,overflow:"hidden"}}>
                {/* Receipt image */}
                <div
                  onClick={()=>setLightbox(r.image)}
                  style={{width:"100%",paddingTop:"65%",position:"relative",background:T.surface,cursor:"pointer",overflow:"hidden"}}>
                  {r.image
                    ?<img src={r.image} alt="receipt" style={{position:"absolute",top:0,left:0,width:"100%",height:"100%",objectFit:"cover",transition:"transform .2s"}}
                       onMouseEnter={e=>e.target.style.transform="scale(1.05)"}
                       onMouseLeave={e=>e.target.style.transform="scale(1)"}/>
                    :<div style={{position:"absolute",inset:0,display:"flex",alignItems:"center",justifyContent:"center",color:T.hint,fontSize:32}}>📄</div>
                  }
                  <div style={{position:"absolute",top:6,right:6,background:"rgba(17,24,39,.8)",borderRadius:4,padding:"2px 7px",fontSize:10,color:T.amber,fontFamily:"'Cinzel',serif",fontWeight:700}}>
                    🔍 View
                  </div>
                </div>
                {/* Info */}
                <div style={{padding:"12px 14px"}}>
                  <div style={{fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,color:T.text,marginBottom:4}}>{r.desc||"Receipt"}</div>
                  {r.amount&&<div style={{fontSize:15,fontWeight:700,color:T.amberGlow,marginBottom:6,fontFamily:"'Cinzel',serif"}}>${parseFloat(r.amount).toFixed(2)}</div>}
                  <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
                    <div style={{display:"flex",alignItems:"center",gap:5}}>
                      {owner&&<><Avatar name={owner.name} picture={owner.picture} size={36}/>
                      <span style={{fontSize:11,color:T.hint}}>{isOwner?"You":owner.name}</span></>}
                    </div>
                    {isOwner&&<button onClick={()=>openEditReceipt(r)}
                      title="Edit" style={{background:"transparent",border:"none",cursor:"pointer",color:T.hint,fontSize:13,padding:"4px 6px"}}>
                      <i className="ti ti-pencil"/>
                    </button>}
                    {isOwner&&<button onClick={()=>doDelReceipt(r.id)}
                      style={{background:T.dangerBg,border:`1px solid ${T.danger}44`,borderRadius:4,cursor:"pointer",color:T.danger,fontSize:12,padding:"3px 7px"}}>
                      <i className="ti ti-trash"/>
                    </button>}
                  </div>
                  {r.createdAt&&<div style={{fontSize:10,color:T.hint,marginTop:6}}>{new Date(r.createdAt).toLocaleDateString("en-CA",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"})}</div>}
                </div>
              </Card>
            );
          })}
        </div>
      }

      {/* Lightbox */}
      {lightbox&&<div
        onClick={()=>setLightbox(null)}
        style={{position:"fixed",inset:0,background:"rgba(0,0,0,.92)",zIndex:9998,display:"flex",alignItems:"center",justifyContent:"center",padding:20,cursor:"zoom-out"}}>
        <img src={lightbox} alt="receipt full" style={{maxWidth:"100%",maxHeight:"90vh",objectFit:"contain",borderRadius:8,boxShadow:`0 0 40px ${T.amber}44`}}/>
        <button onClick={()=>setLightbox(null)} style={{position:"absolute",top:16,right:16,background:T.surface,border:`1px solid ${T.border2}`,borderRadius:"50%",width:36,height:36,cursor:"pointer",color:T.amber,fontSize:18,display:"flex",alignItems:"center",justifyContent:"center"}}>✕</button>
      </div>}
    </div>
  );
}

// ── Engine Room ───────────────────────────────────────────────────────────────
// ── BGG Index (Engine Room) ───────────────────────────────────────────────────
// Publishes BoardGameGeek's "boardgames_ranks.csv" data dump to Firestore (bggIndex/current) so game
// scans resolve to real BGG IDs. The CSV is parsed in the browser and never leaves this device except
// as the trimmed index (games with 500+ ratings, ~7,000 titles, ~300 KB).
export function BggIndexManager({ctx}){
  const {showToast}=ctx;
  const [status,setStatus]=useState({state:"loading"});   // loading | none | ready | error
  const [preview,setPreview]=useState(null);              // {index,fileName}: parsed locally, not yet published
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState("");

  useEffect(()=>{
    let alive=true;
    getDoc(doc(db,"bggIndex","current"))
      .then(snap=>{ if(alive) setStatus(snap.exists()?{state:"ready",meta:snap.data()}:{state:"none"}); })
      .catch(e=>{ if(alive) setStatus({state:"error",msg:e?.code||e?.message||"unknown error"}); });
    return()=>{ alive=false; };
  },[]);

  const onFile=async e=>{
    const f=e.target.files?.[0];
    if(!f) return;
    setErr(""); setPreview(null);
    if(/\.zip$/i.test(f.name)){ setErr("That's the zip — extract it first, then choose boardgames_ranks.csv."); return; }
    try{
      const text=await f.text();
      setPreview({index:buildBggIndex(text),fileName:f.name});
    }catch(ex){ setErr(ex.message||"Couldn't read that file."); }
  };

  const publish=async()=>{
    setBusy(true); setErr("");
    try{
      const payload=bggIndexDoc(preview.index,{source:preview.fileName});
      await saveBggIndex(payload);
      const {games,...meta}=payload;
      setStatus({state:"ready",meta});
      setPreview(null);
      showToast(`📚 BGG index published — ${payload.count.toLocaleString()} games`);
    }catch(ex){
      setErr(ex?.code==="permission-denied"
        ?"Firestore denied the write. Add a security rule letting signed-in users read and write the bggIndex collection, then try again."
        :(ex?.message||"Couldn't save the index."));
    }
    setBusy(false);
  };

  const meta=status.state==="ready"?status.meta:null;
  const pill={fontSize:12,borderRadius:4,padding:"3px 10px",fontFamily:"'Cinzel',serif",fontWeight:700};
  return(
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber}}>📚 BGG Game Index</h3>
        {status.state==="ready"&&<span style={{...pill,color:"#4ADE80",background:"#162A1E",border:"1px solid #166534"}}>
          {meta.count?.toLocaleString()} games
        </span>}
        {status.state==="none"&&<span style={{...pill,color:T.danger,background:"#1A0E0E",border:"1px solid #991B1B"}}>not published</span>}
      </div>

      <p style={{fontSize:12,color:T.muted,lineHeight:1.6,marginBottom:12}}>
        When someone scans or adds a game, its name is looked up here to get the exact BoardGameGeek page.
        Download the <strong>boardgames_ranks</strong> data dump from BoardGameGeek, extract the zip, and choose
        <code> boardgames_ranks.csv</code>. Only games with 500+ ratings are kept.
      </p>

      {status.state==="loading"&&<p style={{fontSize:12,color:T.hint}}>Checking the current index…</p>}
      {status.state==="error"&&<p role="alert" style={{fontSize:12,color:T.danger}}>
        Couldn't read the index ({status.msg}). If this says permission-denied, add a Firestore rule for the bggIndex collection.
      </p>}
      {meta&&<p style={{fontSize:12,color:T.muted,marginBottom:12}}>
        Current index: {meta.count?.toLocaleString()} games with {meta.minRatings}+ ratings
        {meta.source?` · from ${meta.source}`:""}
        {meta.updatedAt?` · published ${new Date(meta.updatedAt).toLocaleDateString("en-CA")}`:""}
      </p>}

      <input type="file" accept=".csv,text/csv" aria-label="BGG ranks CSV" onChange={onFile}
        style={{fontSize:12,color:T.muted,marginBottom:12,maxWidth:"100%"}}/>

      {preview&&<Card style={{background:T.surface,marginBottom:12}}>
        <p style={{fontSize:13,color:T.text,marginBottom:10}}>
          Ready to publish <strong>{preview.index.games.length.toLocaleString()}</strong> games
          ({Math.round(preview.index.bytes/1024)} KB) from <strong>{preview.fileName}</strong>.
          This replaces the current index.
        </p>
        <div style={{display:"flex",gap:8}}>
          <Btn onClick={publish} disabled={busy}>{busy?"Publishing…":"Publish to Firestore"}</Btn>
          <Btn variant="ghost" onClick={()=>setPreview(null)} disabled={busy}>Cancel</Btn>
        </div>
      </Card>}

      {err&&<div role="alert" style={{fontSize:12,color:T.danger,background:T.dangerBg,padding:"8px 12px",borderRadius:6,border:`1px solid ${T.danger}44`,lineHeight:1.4}}>{err}</div>}
    </div>
  );
}

export function EngineRoom({ctx}){
  const [tab,setTab]=useState("itinerary");
  const waitingClaims=Object.values(ctx.missionClaims||{}).filter(c=>c?.status==="pending").length;
  const [unlocked,setUnlocked]=useState(false);
  const [pwInput,setPwInput]=useState("");
  const [pwErr,setPwErr]=useState("");
  const tryUnlock=()=>{ if(pwInput.trim().toLowerCase()==="cottage con"){setUnlocked(true);setPwErr("");}else{setPwErr("Incorrect access code.");setPwInput("");} };
  if(!unlocked) return(
    <div className="cc-fade" style={{maxWidth:400,margin:"0 auto",paddingTop:32}}>
      <SectionTitle sub="Restricted access — engineers only">Engine Room</SectionTitle>
      <Card style={{background:T.surface}}>
        <div style={{textAlign:"center",marginBottom:20}}><div style={{fontSize:48,marginBottom:8}}>⚙️</div>
          <h3 style={{fontFamily:"'Cinzel',serif",fontSize:15,color:T.amber,marginBottom:4}}>Access Required</h3>
          <p style={{fontSize:12,color:T.muted}}>Enter the engine room access code to proceed.</p>
        </div>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Inp label="Access code" type="password" placeholder="Enter access code…" value={pwInput} onChange={e=>setPwInput(e.target.value)} onKeyDown={e=>e.key==="Enter"&&tryUnlock()} error={pwErr}/>
          <Btn onClick={tryUnlock} disabled={!pwInput.trim()} style={{width:"100%"}}><i className="ti ti-lock-open"/> Access Engine Room</Btn>
        </div>
      </Card>
    </div>
  );
  return(
    <div className="cc-fade">
      <SectionTitle sub="Manage itinerary days and deck hand duties">Engine Room</SectionTitle>
      <div style={{display:"flex",gap:8,marginBottom:22,flexWrap:"wrap"}}>
        {[["itinerary","🗓 Itinerary Days"],["deckslots","⚙️ Deck Hand Slots"],["deposits","💰 Deposits"],["ranks","⚓ Crew Ranks"],["notify","📨 Notify"],["costs","🧮 Cost Calculator"],["bgg","📚 BGG Index"],["narrative","🎭 Narrative Roles"],["claims",`📸 Mission Claims${waitingClaims?` (${waitingClaims})`:""}`],["tour","👋 Welcome Tour"]].map(([id,label])=>(
          <button key={id} onClick={()=>setTab(id)} style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"7px 16px",borderRadius:5,cursor:"pointer",border:`2px solid ${tab===id?T.amber:T.border}`,background:tab===id?T.amberSoft:"transparent",color:tab===id?T.amber:T.muted,transition:"all .15s"}}>{label}</button>
        ))}
      </div>
      {tab==="itinerary"&&<ItineraryEditor ctx={ctx}/>}
      {tab==="deckslots"&&<DeckSlotEditor ctx={ctx}/>}
      {tab==="deposits"&&<DepositManager ctx={ctx}/>}
      {tab==="ranks"&&<CrewRankManager ctx={ctx}/>}
      {tab==="notify"&&<NotifyPanel ctx={ctx}/>}
      {tab==="costs"&&<CostCalculator ctx={ctx}/>}
      {tab==="bgg"&&<BggIndexManager ctx={ctx}/>}
      {tab==="narrative"&&<NarrativeManager ctx={ctx}/>}
      {tab==="claims"&&<ClaimsReview ctx={ctx}/>}
      {tab==="tour"&&<WelcomeTourManager ctx={ctx}/>}
    </div>
  );
}

// ── Mission claims review (Engine Room) ───────────────────────────────────────
// A claim's photo lives in its own document and is only fetched when the organiser asks to see it.
export async function fetchProofPhoto(claimId) {
  const snap = await getDoc(doc(db, "missionProofs", claimId));
  return snap.exists() ? snap.data()?.photo || null : null;
}

const claimWhen = ts => ts ? new Date(ts).toLocaleString("en-CA",{month:"short",day:"numeric",hour:"2-digit",minute:"2-digit"}) : "";

function ClaimRow({claim,users,attempt,onReview}){
  const claimant=users?.[claim.claimantId];
  const role=NARRATIVE_ROLES[claim.roleKey];
  const fac=role?NARRATIVE_FACTIONS[role.faction]:null;
  const current=resolveWin(claim.roleKey,peopleOf(users),claim.claimantId);
  const slots=claim.slots?.length?claim.slots:(current?.slots||[]);
  const check=evaluateClaim(claim.roleKey,claim.picks,users,claim.claimantId,claim.slots);
  const [photo,setPhoto]=useState(undefined); // undefined: not fetched yet, null: none found, string: the image
  const [loading,setLoading]=useState(false);
  const [note,setNote]=useState("");
  const [uncounted,setUncounted]=useState(false);
  const [busy,setBusy]=useState(false);

  const showPhoto=async()=>{
    setLoading(true);
    try{ setPhoto(await fetchProofPhoto(claim.id)); }catch{ setPhoto(null); }
    setLoading(false);
  };
  const decide=async d=>{ setBusy(true); await onReview(claim,d,note,uncounted); setBusy(false); };
  const small={fontSize:11,color:T.hint};

  return <div style={{background:T.bgMid,border:`1.5px solid ${fac?.border||T.border2}`,borderRadius:7,padding:"12px 14px"}}>
    <div style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",marginBottom:8}}>
      <Avatar name={claimant?.name} picture={claimant?.picture} size={32}/>
      <div style={{flex:1,minWidth:140}}>
        <div style={{fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,color:T.text}}>{claimant?.name||"Former crew member"}</div>
        <div style={{fontSize:11,color:fac?.color||T.muted}}>{role?`${role.icon} ${role.title}`:"No role"}</div>
      </div>
      <div style={{textAlign:"right"}}>
        <div style={small}>{claimWhen(claim.createdAt)}</div>
        <div style={{...small,color:attempt>=MAX_CLAIM_ATTEMPTS?T.danger:T.hint}}>Attempt {attempt} of {MAX_CLAIM_ATTEMPTS}</div>
      </div>
    </div>

    <div style={{fontSize:12,color:T.muted,marginBottom:8,fontStyle:"italic"}}>{claim.winText||current?.text}</div>

    <div style={{display:"flex",flexDirection:"column",gap:4,marginBottom:8}}>
      {slots.map((sl,i)=>{
        const picked=users?.[claim.picks?.[i]];
        const actual=NARRATIVE_ROLES[picked?.narrativeRole];
        const ok=check.slots[i];
        return <div key={i} data-testid="claim-slot" style={{fontSize:12,color:T.text,display:"flex",gap:8,alignItems:"baseline",flexWrap:"wrap"}}>
          <span style={{color:ok?"#4ADE80":T.danger,fontWeight:700}}>{ok?"✓":"✗"}</span>
          <span style={{color:T.muted}}>{sl.label}:</span>
          <strong>{picked?.name||"Former crew member"}</strong>
          <span style={small}>{ok?"matches":`actually ${actual?actual.title:"no role"}`}</span>
        </div>;
      })}
    </div>

    {claim.note&&<div style={{fontSize:12,color:T.muted,marginBottom:8}}>"{claim.note}"</div>}

    {photo===undefined
      ?<button type="button" disabled={loading} onClick={showPhoto}
        style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"6px 12px",borderRadius:5,cursor:"pointer",border:`1.5px solid ${T.border2}`,background:T.surface2,color:T.text}}>
        {loading?"Loading photo…":"📷 View photo"}
      </button>
      :photo===null
        ?<div role="alert" style={{fontSize:12,color:T.danger}}>No proof photo was found for this claim.</div>
        :<img src={photo} alt="Proof photo" style={{maxWidth:"100%",maxHeight:320,borderRadius:6,border:`1.5px solid ${T.border2}`}}/>}

    {!check.ok&&<div style={{fontSize:11,color:T.danger,marginTop:8}}>This doesn't match the assigned roles, so it can't be approved.</div>}

    <div style={{display:"flex",gap:8,flexWrap:"wrap",marginTop:10,alignItems:"center"}}>
      <input aria-label="Note to the player" value={note} maxLength={300} onChange={e=>setNote(e.target.value)} placeholder="Note to the player (optional)"
        style={{flex:1,minWidth:160,fontFamily:"inherit",fontSize:12,padding:"7px 10px",borderRadius:5,background:T.surface2,color:T.text,border:`1.5px solid ${T.border2}`}}/>
      <Btn size="sm" disabled={!check.ok||busy||photo===null} onClick={()=>decide("approved")}>✓ Approve</Btn>
      <Btn size="sm" variant="danger" disabled={busy} onClick={()=>decide("rejected")}>✗ Reject</Btn>
    </div>
    <label style={{display:"flex",alignItems:"center",gap:6,fontSize:11,color:T.hint,marginTop:8,cursor:"pointer"}}>
      <input type="checkbox" checked={uncounted} onChange={e=>setUncounted(e.target.checked)}/>
      If rejected, don't count it as one of their {MAX_CLAIM_ATTEMPTS} attempts (for example, an unclear photo)
    </label>
  </div>;
}

export function ClaimsReview({ctx}){
  const {users,missionClaims,doReviewMissionClaim,doForgiveClaimAttempt}=ctx;
  const all=Object.values(missionClaims||{}).filter(Boolean);
  const pending=all.filter(c=>c.status==="pending").sort((a,b)=>(a.createdAt||0)-(b.createdAt||0));
  const reviewed=all.filter(c=>c.status!=="pending").sort((a,b)=>(b.reviewedAt||0)-(a.reviewedAt||0));
  const done=completedMissionCount(users,missionClaims,ctx.suspectScores);

  return <div>
    <h3 style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.amber,margin:"0 0 10px"}}>📸 Mission Claims</h3>
    <p style={{fontSize:12,color:T.muted,marginBottom:16,lineHeight:1.6}}>
      Players claim their win condition with a photo as proof, and get {MAX_CLAIM_ATTEMPTS} attempts each. Check the photo, then approve or
      reject. A claim that doesn't match the assigned roles can't be approved. Players are only told the outcome, never which part was wrong.
      {done>0&&` ${done} mission${done===1?"":"s"} complete so far.`}
    </p>

    <div style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,color:T.amber,textTransform:"uppercase",letterSpacing:".08em",marginBottom:8}}>
      Waiting for review ({pending.length})
    </div>
    {pending.length===0
      ?<p style={{fontSize:12,color:T.hint,fontStyle:"italic",margin:"0 0 18px"}}>No claims waiting.</p>
      :<div style={{display:"flex",flexDirection:"column",gap:10,marginBottom:18}}>
        {pending.map(c=><ClaimRow key={c.id} claim={c} users={users} attempt={attemptsUsed(c.claimantId,missionClaims)} onReview={doReviewMissionClaim}/>)}
      </div>}

    {reviewed.length>0&&<>
      <div style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,color:T.muted,textTransform:"uppercase",letterSpacing:".08em",marginBottom:8}}>
        Reviewed ({reviewed.length})
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:6}}>
        {reviewed.map(c=>{
          const ok=c.status==="approved";
          return <div key={c.id} style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",padding:"7px 10px",borderRadius:6,background:T.bgMid,border:`1px solid ${T.border}`}}>
            <span style={{fontSize:12,fontWeight:700,color:ok?"#4ADE80":T.danger}}>{ok?"✓ Approved":"✗ Rejected"}</span>
            <span style={{flex:1,minWidth:100,fontSize:12,color:T.text}}>{users?.[c.claimantId]?.name||"Former crew member"}</span>
            {c.reviewNote&&<span style={{fontSize:11,color:T.muted,fontStyle:"italic"}}>"{c.reviewNote}"</span>}
            {c.uncounted&&<span style={{fontSize:11,color:T.hint}}>(attempt returned)</span>}
            {c.status==="rejected"&&!c.uncounted&&doForgiveClaimAttempt&&<button type="button" onClick={()=>doForgiveClaimAttempt(c)}
              style={{fontFamily:"inherit",fontSize:11,padding:"3px 8px",borderRadius:4,cursor:"pointer",border:`1px solid ${T.border2}`,background:T.surface2,color:T.text}}>
              Give attempt back
            </button>}
            <span style={{fontSize:11,color:T.hint}}>{claimWhen(c.reviewedAt)}</span>
          </div>;
        })}
      </div>
    </>}
  </div>;
}

// ── Welcome Tour reset (Engine Room) ─────────────────────────────────────────
export function WelcomeTourManager({ctx}){
  const {users,doResetOnboarding}=ctx;
  const crew=Object.values(users||{});
  const waiting=crew.filter(u=>u.onboarded===false).length;
  const [confirming,setConfirming]=useState(false);
  const [busy,setBusy]=useState(false);
  const [result,setResult]=useState(null);

  const reset=async()=>{
    setBusy(true);
    try{ setResult(await doResetOnboarding()); }
    catch{ setResult({total:crew.length,done:0,failed:crew.map(u=>u.id)}); }
    setBusy(false);
    setConfirming(false);
  };

  return <div>
    <h3 style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.amber,margin:"0 0 10px"}}>👋 Welcome Tour</h3>
    <p style={{fontSize:12,color:T.muted,marginBottom:16,lineHeight:1.6}}>
      Replays the welcome tour for the whole crew. Each person sees it again the next time they open or reload the app, and it
      stops once they finish or skip it.
    </p>

    <Card style={{background:T.bgMid}}>
      <div style={{fontSize:13,color:T.text,marginBottom:14}}>
        {crew.length===0
          ?"No crew have joined yet."
          :waiting===0
            ?`No one is waiting to see the tour (${crew.length} crew).`
            :`${waiting} of ${crew.length} crew have the tour waiting.`}
      </div>

      {!confirming
        ?<Btn variant="danger" disabled={crew.length===0||busy} onClick={()=>setConfirming(true)}>
          <i className="ti ti-refresh"/> Reset for everyone
        </Btn>
        :<div role="alertdialog" aria-label="Confirm reset" style={{border:`1.5px solid ${T.danger}55`,background:T.dangerBg,borderRadius:6,padding:"12px 14px"}}>
          <div style={{fontSize:12,color:T.text,marginBottom:10,lineHeight:1.5}}>
            Replay the tour for all {crew.length} crew members?
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <Btn variant="danger" disabled={busy} onClick={reset}>{busy?"Resetting…":"Yes, reset everyone"}</Btn>
            <Btn variant="ghost" disabled={busy} onClick={()=>setConfirming(false)}>Cancel</Btn>
          </div>
        </div>}

      {result&&<div role="status" style={{marginTop:14,fontSize:12,lineHeight:1.5,
        color:result.failed.length?T.danger:"#4ADE80"}}>
        {result.failed.length
          ?`⚠️ Reset ${result.done} of ${result.total} crew. Press the button again to retry the rest.`
          :`✓ Reset for ${result.done} crew. They will see the tour the next time they open or reload the app.`}
      </div>}
    </Card>
  </div>;
}

// ── Narrative Manager (Engine Room) ──────────────────────────────────────────
export function NarrativeManager({ctx}){
  const {users,doAssignNarrativeRole,showToast}=ctx;
  const uList=Object.entries(users).map(([id,u])=>({...u,id}));
  const factions=Object.entries(NARRATIVE_FACTIONS);
  const roles=Object.entries(NARRATIVE_ROLES);
  const assigned=new Set(uList.map(u=>u.narrativeRole));

  const randomAssign=async()=>{
    const picks=pickRandomRoles(uList.length);
    for(let i=0;i<uList.length;i++){
      await doAssignNarrativeRole(uList[i].id,picks[i],true);
    }
    showToast("🎭 Roles randomly assigned!");
  };

  return <div>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
      <h3 style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.amber,margin:0}}>🎭 Narrative Role Assignment</h3>
      <button onClick={randomAssign} style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"8px 18px",borderRadius:5,cursor:"pointer",border:`2px solid ${T.amber}`,background:T.amberSoft,color:T.amber}}>
        <i className="ti ti-arrows-shuffle"/> Randomly Assign All
      </button>
    </div>
    <p style={{fontSize:12,color:T.muted,marginBottom:20,lineHeight:1.6}}>
      Assign each crew member a secret role. They will see their own dossier at the top of their <strong style={{color:T.amber}}>Personal Log</strong> — but never anyone else's. Roles can be reassigned at any time.
    </p>

    {/* Faction legend */}
    <div style={{display:"flex",gap:10,marginBottom:20,flexWrap:"wrap"}}>
      {factions.map(([key,f])=>(
        <div key={key} style={{display:"inline-flex",alignItems:"center",gap:6,fontSize:11,fontWeight:700,
          padding:"4px 12px",borderRadius:4,background:f.bg,color:f.color,border:`1.5px solid ${f.border}`}}>
          {f.icon} {f.name}
        </div>
      ))}
    </div>

    {/* Per-user role selectors */}
    <div style={{display:"flex",flexDirection:"column",gap:10}}>
      {uList.map(u=>{
        const current=NARRATIVE_ROLES[u.narrativeRole];
        const fac=current?NARRATIVE_FACTIONS[current.faction]:null;
        const missingTitles=u.narrativeRole?requiredRoles(u.narrativeRole).filter(r=>!assigned.has(r)).map(r=>NARRATIVE_ROLES[r].title):[];
        const noTarget=missingTitles.length?missingTitles.join(" and "):null;
        const stuck=u.narrativeRole?unachievableWin(u.narrativeRole,uList,u.id):null;
        return <div key={u.id} style={{background:T.bgMid,border:`1.5px solid ${fac?.border||T.border2}`,borderRadius:7,padding:"12px 14px",display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
          <Avatar name={u.name} picture={u.picture} size={34}/>
          <div style={{flex:1,minWidth:0}}>
            <div style={{fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,color:T.text}}>{u.name}</div>
            {current
              ?<div style={{fontSize:11,color:fac?.color||T.muted,marginTop:2}}>{current.icon} {current.title}</div>
              :<div style={{fontSize:11,color:T.hint,marginTop:2,fontStyle:"italic"}}>No role assigned</div>
            }
            {noTarget&&<div style={{fontSize:11,color:T.danger,marginTop:3}}>⚠️ No {noTarget} {missingTitles.length>1?"are":"is"} assigned, so this role has nobody to target</div>}
            {!noTarget&&stuck&&<div style={{fontSize:11,color:T.danger,marginTop:3}}>⚠️ Win condition can't be completed: {stuck}</div>}
          </div>
          <select
            value={u.narrativeRole||""}
            onChange={e=>doAssignNarrativeRole(u.id,e.target.value||null)}
            style={{fontFamily:"inherit",fontSize:12,padding:"6px 10px",borderRadius:5,
              background:T.surface2,color:T.text,border:`1.5px solid ${T.border2}`,cursor:"pointer",maxWidth:220}}>
            <option value="">— No role —</option>
            {factions.map(([fKey,f])=>(
              <optgroup key={fKey} label={`${f.icon} ${f.name}`}>
                {roles.filter(([,r])=>r.faction===fKey).map(([rKey,r])=>(
                  <option key={rKey} value={rKey}>{r.icon} {r.title}</option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>;
      })}
    </div>
  </div>;
}

// ── Role guess board (private notes inside the dossier) ──────────────────────
// Kept in localStorage, not Firestore: every signed-in user can read every Firestore user doc, so a guess saved there
// would not be private. The trade-off is that guesses stay on the device they were made on.
const guessKey = uid => `cc-role-guesses:${uid}`;
function loadGuesses(uid){
  try{
    const v=JSON.parse(localStorage.getItem(guessKey(uid))||"{}");
    return v&&typeof v==="object"&&!Array.isArray(v)?v:{};
  }catch{ return {}; }
}
function saveGuesses(uid,g){
  try{ localStorage.setItem(guessKey(uid),JSON.stringify(g)); }catch{ /* storage blocked or full: notes just won't persist */ }
}

// Guess value for a crew member who was never given a role, so the board can't reveal who is playing.
export const NOT_PLAYING = "none";

// Scores guesses against the roles currently assigned. Returns a count only, never which guesses were right.
export function scoreGuesses(guesses, users, selfUid){
  const crew=Object.entries(users||{}).filter(([id])=>id!==selfUid);
  const correct=crew.filter(([id,u])=>guesses?.[id]===(NARRATIVE_ROLES[u?.narrativeRole]?u.narrativeRole:NOT_PLAYING)).length;
  return {correct,total:crew.length};
}

const MAX_SCORE_HISTORY = 50;
const isCheckResult = r => !!r && Number.isInteger(r.correct) && Number.isInteger(r.total) && r.correct >= 0 && r.correct <= r.total;
const bestRatio = r => r.bestTotal > 0 ? r.bestCorrect / r.bestTotal : 0;

// A player's shared leaderboard record (Firestore `suspectScores/<uid>`) after one more check. `prev` may be missing or
// malformed. `checks` keeps counting after `history` is trimmed to the latest results; `solvedInChecks` is set once.
export function nextSuspectScore(prev, result, now = Date.now()) {
  const old = prev && typeof prev === "object" ? prev : {};
  const oldHistory = Array.isArray(old.history) ? old.history.filter(isCheckResult) : [];
  const checks = (Number.isInteger(old.checks) && old.checks >= oldHistory.length ? old.checks : oldHistory.length) + 1;
  const history = [...oldHistory, { correct: result.correct, total: result.total }].slice(-MAX_SCORE_HISTORY);
  const oldBest = isCheckResult({ correct: old.bestCorrect, total: old.bestTotal }) ? { correct: old.bestCorrect, total: old.bestTotal } : null;
  const ratio = r => r.total > 0 ? r.correct / r.total : 0;
  const beatsOld = !oldBest || ratio(result) > ratio(oldBest) || (ratio(result) === ratio(oldBest) && result.correct > oldBest.correct);
  const best = beatsOld ? result : oldBest;
  const solved = result.total > 0 && result.correct === result.total;
  return {
    checks, history,
    bestCorrect: best.correct, bestTotal: best.total,
    lastCorrect: result.correct, lastTotal: result.total,
    solvedInChecks: Number.isInteger(old.solvedInChecks) ? old.solvedInChecks : (solved ? checks : null),
    updatedAt: now,
  };
}

// Leaderboard order: best single check (as a share of the crew) first, then fewer checks used, then who got there first.
// Players with equal results share a rank. Only people still in the crew and with at least one check appear.
export function rankSuspectScores(scores, users) {
  const rows = Object.entries(scores || {})
    .filter(([id, s]) => users?.[id] && s && Number.isInteger(s.checks) && s.checks > 0 && isCheckResult({ correct: s.bestCorrect, total: s.bestTotal }))
    .map(([id, s]) => ({
      id, name: users[id].name || "Crew member", picture: users[id].picture,
      checks: s.checks, bestCorrect: s.bestCorrect, bestTotal: s.bestTotal,
      solved: Number.isInteger(s.solvedInChecks), updatedAt: Number(s.updatedAt) || 0,
    }));
  const cmp = (a, b) => bestRatio(b) - bestRatio(a) || b.bestCorrect - a.bestCorrect || a.checks - b.checks;
  rows.sort((a, b) => cmp(a, b) || a.updatedAt - b.updatedAt || a.name.localeCompare(b.name));
  return rows.map(r => ({ ...r, rank: 1 + rows.filter(o => cmp(o, r) < 0).length }));
}

// Writes one more check to the shared leaderboard. Lives in its own collection, not on the user doc, because the profile
// form re-saves a copy of the user doc loaded at sign-in and would overwrite newer scores with stale ones.
export async function recordSuspectCheck(uid, prev, result) {
  if (!uid || !isCheckResult(result)) return null;
  const next = nextSuspectScore(prev, result);
  await fsSet("suspectScores", uid, next);
  return next;
}

export function SuspectLeaderboard({scores,users,uid}){
  const rows=rankSuspectScores(scores,users);
  const medal=r=>r===1?"🥇":r===2?"🥈":r===3?"🥉":`#${r}`;
  return <div style={{marginTop:18}}>
    <div style={{fontSize:11,fontWeight:700,color:T.amber,textTransform:"uppercase",letterSpacing:".08em",fontFamily:"'Cinzel',serif",marginBottom:8}}>
      🏆 Leaderboard
    </div>
    {rows.length===0
      ?<p style={{fontSize:12,color:T.hint,fontStyle:"italic",margin:0}}>No checks yet — be the first to crack the crew.</p>
      :<div style={{display:"flex",flexDirection:"column",gap:6}}>
        {rows.map(r=>{
          const me=r.id===uid;
          return <div key={r.id} style={{display:"flex",alignItems:"center",gap:10,padding:"7px 10px",borderRadius:6,
            background:me?T.amberSoft:T.bgMid,border:`1.5px solid ${me?T.amber:T.border}`}}>
            <span style={{width:34,textAlign:"center",fontSize:r.rank<=3?18:12,color:T.muted,fontFamily:"'Cinzel',serif",fontWeight:700}}>{medal(r.rank)}</span>
            <Avatar name={r.name} picture={r.picture} size={26}/>
            <span style={{flex:1,minWidth:0,fontSize:13,fontWeight:me?700:500,color:T.text,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
              {r.name}{me&&<span style={{fontSize:10,color:T.amber,marginLeft:6}}>(you)</span>}
            </span>
            <span style={{fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,color:r.solved?"#4ADE80":T.amber}}>
              {r.solved?"🎉 ":""}{r.bestCorrect}/{r.bestTotal}
            </span>
            <span style={{fontSize:11,color:T.hint,minWidth:62,textAlign:"right"}}>{r.checks} {r.checks===1?"check":"checks"}</span>
          </div>;
        })}
      </div>}
  </div>;
}

export function RoleGuessBoard({uid,users,allScores,onRecordCheck}){
  const [guesses,setGuesses]=useState(()=>loadGuesses(uid));
  const myScore=allScores?.[uid];
  const crew=Object.entries(users||{}).filter(([id])=>id!==uid).map(([id,u])=>({...u,id}))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const factions=Object.entries(NARRATIVE_FACTIONS);
  const roles=Object.entries(NARRATIVE_ROLES);
  const guessFor=id=>NARRATIVE_ROLES[guesses[id]]||guesses[id]===NOT_PLAYING?guesses[id]:"";
  const marked=crew.filter(c=>guessFor(c.id)).length;
  const needMarked=minMarkedToCheck(crew.length);
  const canCheck=crew.length>0&&marked>=needMarked;
  const history=Array.isArray(myScore?.history)?myScore.history.filter(isCheckResult):[];
  const checksMade=Number.isInteger(myScore?.checks)&&myScore.checks>=history.length?myScore.checks:history.length;
  const last=history.at(-1);
  const perfect=!!last&&last.total>0&&last.correct===last.total;
  const setGuess=(id,roleKey)=>{
    const next={...guesses};
    if(roleKey) next[id]=roleKey; else delete next[id];
    saveGuesses(uid,next);
    setGuesses(next);
  };
  const runCheck=()=>{
    if(!canCheck) return;
    const valid=Object.fromEntries(crew.map(c=>[c.id,guessFor(c.id)]));
    onRecordCheck?.(scoreGuesses(valid,users,uid));
  };

  return <Card style={{marginTop:14,border:`1.5px solid ${T.border2}`}}>
    <div style={{display:"flex",alignItems:"baseline",justifyContent:"space-between",gap:8,flexWrap:"wrap",marginBottom:6}}>
      <div style={{fontSize:11,fontWeight:700,color:T.amber,textTransform:"uppercase",letterSpacing:".08em",fontFamily:"'Cinzel',serif"}}>
        🗂️ Crew Suspect Board
      </div>
      <div style={{fontSize:11,color:T.hint}}>{marked} of {crew.length} marked</div>
    </div>
    <p style={{fontSize:11,color:T.hint,lineHeight:1.5,margin:"0 0 12px"}}>
      Your private guesses about who holds which role. Saved on this device only — nobody else can see them.
    </p>
    {crew.length===0
      ?<p style={{fontSize:12,color:T.hint,fontStyle:"italic",margin:0}}>No other crew have joined yet.</p>
      :<div style={{display:"flex",flexDirection:"column",gap:8}}>
        {crew.map(c=>{
          const g=guessFor(c.id);
          const role=g?NARRATIVE_ROLES[g]:null;
          const fac=role?NARRATIVE_FACTIONS[role.faction]:null;
          return <div key={c.id} style={{display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",padding:"8px 10px",
            background:fac?fac.bg:T.bgMid,borderRadius:6,border:`1.5px solid ${fac?fac.border:T.border}`}}>
            <Avatar name={c.name} picture={c.picture} size={30}/>
            <span style={{flex:1,minWidth:100,fontSize:13,fontWeight:500,color:T.text}}>{c.name||"Crew member"}</span>
            <select aria-label={`Guess role for ${c.name||"crew member"}`} value={g}
              onChange={e=>setGuess(c.id,e.target.value)}
              style={{fontFamily:"inherit",fontSize:12,padding:"6px 10px",borderRadius:5,background:T.surface2,
                color:fac?fac.color:T.text,border:`1.5px solid ${fac?fac.border:T.border2}`,cursor:"pointer",maxWidth:230}}>
              <option value="">— Unknown —</option>
              {factions.map(([fKey,f])=>(
                <optgroup key={fKey} label={`${f.icon} ${f.name}`}>
                  {roles.filter(([,r])=>r.faction===fKey).map(([rKey,r])=>(
                    <option key={rKey} value={rKey}>{r.icon} {r.title}</option>
                  ))}
                </optgroup>
              ))}
              <option value={NOT_PLAYING}>🚫 Not playing (no role)</option>
            </select>
          </div>;
        })}
      </div>}

    {crew.length>0&&<div style={{marginTop:14}}>
      <Btn onClick={runCheck} disabled={!canCheck} style={{width:"100%"}}>
        <i className="ti ti-checks"/> Check my guesses
      </Btn>
      {!canCheck&&<div style={{fontSize:11,color:T.hint,marginTop:6,textAlign:"center"}}>
        {needMarked===crew.length
          ?`Mark all ${crew.length} crew members to unlock the check — ${crew.length-marked} to go.`
          :`Mark at least ${needMarked} of ${crew.length} crew members to unlock the check — ${needMarked-marked} to go. Anyone left unmarked counts as wrong.`}
      </div>}
      {last&&<div role="status" style={{marginTop:10,padding:"10px 14px",borderRadius:6,textAlign:"center",
        border:`1.5px solid ${perfect?"#166534":T.amber}`,background:perfect?"#162A1E":T.bgMid,
        color:perfect?"#4ADE80":T.amber,fontFamily:"'Cinzel',serif",fontSize:14,fontWeight:700}}>
        {perfect?`🎉 All ${last.total} correct!`:`${last.correct} of ${last.total} correct`}
      </div>}
      <div style={{fontSize:11,color:T.hint,marginTop:8,textAlign:"center"}}>
        Checks made: {checksMade}
        {history.length>1&&` · history: ${history.length>10?"…, ":""}${history.slice(-10).map(r=>`${r.correct}/${r.total}`).join(", ")}`}
      </div>
    </div>}

    <SuspectLeaderboard scores={allScores} users={users} uid={uid}/>
  </Card>;
}

// ── Proof photo picker ────────────────────────────────────────────────────────
function ProofPhotoPicker({photo,onPhoto,compress,hint}){
  const fileRef=useRef(null);
  const [busy,setBusy]=useState(false);
  const [err,setErr]=useState("");
  const choose=async e=>{
    const f=e.target.files?.[0];
    e.target.value="";
    if(!f) return;
    setBusy(true); setErr("");
    try{ onPhoto(await prepareProofPhoto(f,compress)); }
    catch(ex){ setErr(ex.message||"Couldn't use that photo."); }
    setBusy(false);
  };
  const btn={fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"7px 12px",borderRadius:5,cursor:"pointer",
    border:`1.5px solid ${T.border2}`,background:T.surface2,color:T.text};
  return <div>
    <input ref={fileRef} type="file" accept="image/*" aria-label="Proof photo" onChange={choose} style={{display:"none"}}/>
    {photo
      ?<div style={{display:"flex",alignItems:"center",gap:12,flexWrap:"wrap"}}>
        <img src={photo} alt="Proof preview" style={{width:76,height:76,objectFit:"cover",borderRadius:6,border:`1.5px solid ${T.border2}`}}/>
        <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
          <button type="button" onClick={()=>fileRef.current?.click()} style={btn}>Change photo</button>
          <button type="button" onClick={()=>onPhoto("")} style={{...btn,color:T.muted}}>Remove</button>
        </div>
      </div>
      :<button type="button" disabled={busy} onClick={()=>fileRef.current?.click()} style={{...btn,opacity:busy?.6:1}}>
        {busy?"Preparing photo…":"📷 Add proof photo"}
      </button>}
    {hint&&<div style={{fontSize:11,color:T.hint,marginTop:6,lineHeight:1.5}}>{hint}</div>}
    {err&&<div role="alert" style={{fontSize:12,color:T.danger,marginTop:6,padding:"6px 10px",background:T.dangerBg,borderRadius:5,border:`1px solid ${T.danger}44`}}>{err}</div>}
  </div>;
}

// ── Mission card (win condition + claim with photo proof) ─────────────────────
export function MissionCard({roleKey,uid,users,claims,scores,onSubmit,compress,fac}){
  const win=resolveWin(roleKey,peopleOf(users),uid);
  const [picks,setPicks]=useState([]);
  const [note,setNote]=useState("");
  const [photo,setPhoto]=useState("");
  const [busy,setBusy]=useState(false);
  if(!win) return null;

  const border=fac?.border||T.border2;
  const labelStyle={fontSize:11,fontWeight:700,color:fac?.color||T.amber,textTransform:"uppercase",letterSpacing:".08em",fontFamily:"'Cinzel',serif"};
  const crew=Object.entries(users||{}).filter(([id])=>id!==uid).map(([id,u])=>({...u,id}))
    .sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const done=completedMissionCount(users,claims,scores);
  const status=missionStatus(uid,claims);
  const left=attemptsLeft(uid,claims);
  const slots=win.slots;
  const complete=slots.length>0&&picks.length===slots.length&&picks.every(Boolean)&&new Set(picks).size===picks.length;
  const canSend=complete&&!!photo&&!busy;

  const send=async()=>{
    setBusy(true);
    const ok=await onSubmit?.({picks,note,photo});
    setBusy(false);
    if(ok){ setPicks([]); setNote(""); setPhoto(""); }
  };
  const setPick=(i,id)=>setPicks(p=>{ const n=[...p]; n[i]=id; return n; });

  const banner=(text,color,bg,line)=><div role="status" style={{marginTop:12,padding:"10px 14px",borderRadius:6,textAlign:"center",
    border:`1.5px solid ${line}`,background:bg,color,fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700}}>{text}</div>;

  let body;
  if(win.type==="board"){
    const sc=scores?.[uid];
    const met=boardMissionMet(roleKey,sc);
    body=<>
      <div style={{fontSize:12,color:T.muted,lineHeight:1.6}}>
        Judged automatically from your Crew Suspect Board checks: get {win.required} or more correct in a single check.
        {sc&&sc.bestTotal>0?` Your best check so far is ${sc.bestCorrect} of ${sc.bestTotal}.`:" You haven't checked your guesses yet."}
      </div>
      {met&&banner("🎉 Mission accomplished!","#4ADE80","#162A1E","#166534")}
    </>;
  } else if(status.state==="approved"){
    body=<>
      {banner("🎉 Mission accomplished!","#4ADE80","#162A1E","#166534")}
      {status.claim.reviewNote&&<div style={{fontSize:12,color:T.muted,marginTop:8,fontStyle:"italic",textAlign:"center"}}>Organiser's note: {status.claim.reviewNote}</div>}
    </>;
  } else if(status.state==="pending"){
    body=banner("⏳ Claim sent. Waiting for the organiser to review your proof.",T.amber,T.bgMid,`${T.amber}55`);
  } else {
    body=<>
      {status.state==="rejected"&&<div role="status" style={{marginBottom:12,padding:"9px 12px",borderRadius:6,fontSize:12,lineHeight:1.5,
        color:T.danger,background:T.dangerBg,border:`1px solid ${T.danger}44`}}>
        Your last claim wasn't approved.{status.claim.reviewNote?` Organiser's note: ${status.claim.reviewNote}`:""}{left>0?" You can send a new one.":""}
      </div>}
      {left===0
        ?<div role="status" style={{padding:"10px 14px",borderRadius:6,fontSize:12,lineHeight:1.5,textAlign:"center",
          color:T.danger,background:T.dangerBg,border:`1px solid ${T.danger}44`}}>
          You've used all {MAX_CLAIM_ATTEMPTS} of your attempts. If you think a claim was turned down unfairly, ask the organiser.
        </div>
        :<>
          <div style={{fontSize:12,color:T.muted,marginBottom:6,lineHeight:1.6}}>
            Claim it with a photo as proof. The organiser reviews every claim, so you won't be told straight away whether you picked the right people.
          </div>
          <div style={{fontSize:11,fontWeight:700,color:left===1?T.danger:T.amber,marginBottom:12,fontFamily:"'Cinzel',serif",letterSpacing:".04em"}}>
            Attempts left: {left} of {MAX_CLAIM_ATTEMPTS}
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {slots.map((sl,i)=>(
              <div key={i}>
                <label style={{display:"block",fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4}}>{sl.label}</label>
                <select aria-label={sl.label} value={picks[i]||""} onChange={e=>setPick(i,e.target.value)}
                  style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"8px 10px",borderRadius:5,background:T.surface2,color:T.text,border:`1.5px solid ${T.border2}`}}>
                  <option value="">— Choose a crew member —</option>
                  {crew.map(c=><option key={c.id} value={c.id} disabled={picks.includes(c.id)&&picks[i]!==c.id}>{c.name||"Crew member"}</option>)}
                </select>
              </div>
            ))}
            <div>
              <label style={{display:"block",fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4}}>Where and when? (optional)</label>
              <input aria-label="Where and when" value={note} maxLength={300} onChange={e=>setNote(e.target.value)} placeholder="e.g. by the fire, Friday night"
                style={{width:"100%",boxSizing:"border-box",fontFamily:"inherit",fontSize:13,padding:"8px 10px",borderRadius:5,background:T.surface2,color:T.text,border:`1.5px solid ${T.border2}`}}/>
            </div>
            <ProofPhotoPicker photo={photo} onPhoto={setPhoto} compress={compress} hint={win.proofHint}/>
            <Btn onClick={send} disabled={!canSend} style={{width:"100%"}}>{busy?"Sending…":"📸 Send claim for review"}</Btn>
            {!canSend&&!busy&&<div style={{fontSize:11,color:T.hint,textAlign:"center"}}>
              {!complete?"Choose a different crew member for each part.":"Add a proof photo to send your claim."}
            </div>}
          </div>
        </>}
    </>;
  }

  return <Card style={{marginBottom:14,border:`1.5px solid ${border}44`}}>
    <div style={{...labelStyle,marginBottom:8}}>🏁 Win Condition</div>
    <p style={{fontSize:14,color:T.text,lineHeight:1.6,margin:"0 0 12px",fontWeight:600}}>{win.text}</p>
    {body}
    <div style={{fontSize:11,color:T.hint,marginTop:12,textAlign:"center"}}>
      {done===0?"No missions completed yet.":`🏁 ${done} mission${done===1?"":"s"} completed across the crew.`}
    </div>
  </Card>;
}

// ── Narrative Dossier (player view) ──────────────────────────────────────────
export function NarrativeDossier({ctx}){
  const {profile,authUser,users,suspectScores,doRecordSuspectCheck,missionClaims,doSubmitMissionClaim,proofCompress}=ctx;
  // Read the live user doc: `profile` is loaded once at sign-in, so it would miss a role assigned afterwards
  const me=(authUser&&users?.[authUser.uid])||profile;
  const roleKey=me?.narrativeRole;
  const role=roleKey?NARRATIVE_ROLES[roleKey]:null;
  const fac=role?NARRATIVE_FACTIONS[role.faction]:null;
  const [revealed,setRevealed]=useState(false);

  if(!role){
    return <div style={{marginBottom:18}}>
      <Card style={{textAlign:"center",padding:"28px 24px"}}>
        <div style={{fontSize:40,marginBottom:10}}>🔒</div>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:16,color:T.amber,marginBottom:8}}>No Dossier Assigned</h3>
        <p style={{fontSize:13,color:T.muted,lineHeight:1.7,maxWidth:340,margin:"0 auto"}}>
          Your mission briefing hasn't been issued yet. The Engine Room officer will assign your role before the operation begins. Check back soon.
        </p>
      </Card>
    </div>;
  }

  return <div style={{marginBottom:18}}>

    {/* Sealed dossier — tap to reveal */}
    {!revealed
      ?<div onClick={()=>setRevealed(true)} style={{cursor:"pointer"}}><Card style={{textAlign:"center",padding:"32px 24px",border:`2px solid ${fac.border}`,background:fac.bg}}>
        <div style={{fontSize:44,marginBottom:12}}>📁</div>
        <div style={{fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,color:fac.color,marginBottom:6,letterSpacing:".08em",textTransform:"uppercase"}}>
          {fac.icon} {fac.name} — Classified
        </div>
        <div style={{fontSize:12,color:T.muted,marginBottom:24}}>This dossier is sealed. Tap to open — make sure no one is looking over your shoulder.</div>
        <button style={{fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,padding:"12px 28px",
          borderRadius:6,border:`2px solid ${fac.border}`,background:fac.bg,color:fac.color,cursor:"pointer"}}>
          🔓 Open Your Dossier
        </button>
      </Card></div>

      :<div style={{animation:"ccFadeIn .2s ease"}}>
        {/* Header card */}
        <Card style={{marginBottom:14,border:`2.5px solid ${fac.border}`,background:fac.bg,
          boxShadow:`0 0 24px ${fac.glow}33`}}>
          <div style={{display:"flex",alignItems:"center",gap:14,marginBottom:16,flexWrap:"wrap"}}>
            <div style={{fontSize:52,lineHeight:1}}>{role.icon}</div>
            <div style={{flex:1,minWidth:0}}>
              <div style={{fontSize:10,fontWeight:700,letterSpacing:".1em",textTransform:"uppercase",
                color:fac.color,marginBottom:4,fontFamily:"'Cinzel',serif"}}>{fac.icon} {fac.name}</div>
              <div style={{fontFamily:"'Cinzel',serif",fontSize:18,fontWeight:700,color:T.text,lineHeight:1.2}}>{role.title}</div>
              <div style={{fontSize:12,color:T.muted,marginTop:4,fontStyle:"italic"}}>{role.subtitle}</div>
            </div>
          </div>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
            <div style={{flex:1,minWidth:180,background:T.bgMid,borderRadius:6,padding:"10px 14px",border:`1px solid ${T.border}`}}>
              <div style={{fontSize:10,color:T.hint,fontWeight:700,textTransform:"uppercase",letterSpacing:".06em",marginBottom:4}}>Cover Story</div>
              <div style={{fontSize:12,color:T.muted,lineHeight:1.5}}>{role.cover}</div>
            </div>
          </div>
        </Card>

        {/* Secret briefing */}
        <Card style={{marginBottom:14,border:`1.5px solid ${fac.border}44`}}>
          <div style={{fontSize:11,fontWeight:700,color:fac.color,textTransform:"uppercase",letterSpacing:".08em",marginBottom:10,fontFamily:"'Cinzel',serif"}}>
            🔐 Secret Briefing
          </div>
          <p style={{fontSize:13,color:T.text,lineHeight:1.8,margin:0,borderLeft:`3px solid ${fac.border}`,paddingLeft:14}}>
            {role.secret}
          </p>
        </Card>

        {/* Objectives */}
        <Card style={{marginBottom:14,border:`1.5px solid ${fac.border}44`}}>
          <div style={{fontSize:11,fontWeight:700,color:fac.color,textTransform:"uppercase",letterSpacing:".08em",marginBottom:12,fontFamily:"'Cinzel',serif"}}>
            🎯 Mission Objectives
          </div>
          <div style={{display:"flex",flexDirection:"column",gap:10}}>
            {role.objectives.map((obj,i)=>(
              <div key={i} style={{display:"flex",gap:10,alignItems:"flex-start"}}>
                <div style={{width:22,height:22,borderRadius:4,border:`1.5px solid ${fac.border}`,
                  background:fac.bg,display:"flex",alignItems:"center",justifyContent:"center",
                  fontSize:11,fontWeight:700,color:fac.color,flexShrink:0,fontFamily:"'Cinzel',serif"}}>
                  {i+1}
                </div>
                <span style={{fontSize:13,color:T.text,lineHeight:1.6,paddingTop:2}}>{obj}</span>
              </div>
            ))}
          </div>
        </Card>

        {/* Win condition and claim */}
        {authUser&&<MissionCard roleKey={roleKey} uid={authUser.uid} users={users} claims={missionClaims} scores={suspectScores}
          onSubmit={doSubmitMissionClaim} compress={proofCompress} fac={fac}/>}

        {/* Field intelligence note */}
        <Card style={{border:`1.5px solid ${T.amber}44`,background:T.bgMid}}>
          <div style={{fontSize:11,fontWeight:700,color:T.amber,textTransform:"uppercase",letterSpacing:".08em",marginBottom:8,fontFamily:"'Cinzel',serif"}}>
            ⚠️ Field Intelligence
          </div>
          <p style={{fontSize:12,color:T.muted,lineHeight:1.7,margin:0,fontStyle:"italic"}}>
            {role.suspectHint}
          </p>
        </Card>

        {/* Private guesses about the rest of the crew */}
        {authUser&&<RoleGuessBoard uid={authUser.uid} users={users} allScores={suspectScores} onRecordCheck={doRecordSuspectCheck}/>}

        {/* Reseal button */}
        <div style={{textAlign:"center",marginTop:18}}>
          <button onClick={()=>setRevealed(false)}
            style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"8px 20px",
              borderRadius:5,border:`1.5px solid ${T.border2}`,background:"transparent",
              color:T.muted,cursor:"pointer",letterSpacing:".05em"}}>
            🔒 Seal Dossier
          </button>
        </div>
      </div>
    }
  </div>;
}

// ── Itinerary Editor ──────────────────────────────────────────────────────────
function ItineraryEditor({ctx}){
  const {itinerary,doSaveItinDay,doDelItinDay,doSaveItinMeta,itinMeta,showToast}=ctx;

  // Hooks first — React rules of hooks
  const [editingId,  setEditingId]  = useState(null);
  const [showAddDay, setShowAddDay] = useState(false);
  const [form,       setForm]       = useState({date:"",short:"",label:"",icon:"⚓",notes:"",activities:""});
  const [editForm,   setEditForm]   = useState({});
  const [meta,       setMeta]       = useState({
    checkIn:    itinMeta.checkIn    || "3 PM",
    checkInDay: itinMeta.checkInDay || "Thursday Nov 26",
    checkOut:   itinMeta.checkOut   || "11 AM",
    checkOutDay:itinMeta.checkOutDay|| "Sunday Nov 29",
    parkingNote:itinMeta.parkingNote|| "Parking available on site for all crew vehicles",
  });
  const [metaDirty, setMetaDirty]   = useState(false);
  const [metaSaving,setMetaSaving]  = useState(false);
  const saveMeta = async () => {
    setMetaSaving(true);
    await doSaveItinMeta(meta);
    setMetaSaving(false); setMetaDirty(false);
    showToast("Check-in/out times saved! 🕐");
  };

  // Derived from Firestore itinerary data
  const itinValues = Object.values(itinerary || {});
  const baseDays = COTTAGE_DAYS.map(d => {
    const stableId = d.short.replace(/\s+/g, '_');
    const saved    = itinValues.find(x => x.short === d.short || x.id === stableId);
    return saved
      ? {...d, ...saved, id: saved.id || stableId, activities: saved.activities?.length ? saved.activities : DEFAULT_ACTIVITIES[d.short] || []}
      : {...d, activities: DEFAULT_ACTIVITIES[d.short] || [], id: stableId};
  });
  const extraDays = itinValues
    .filter(d => !isBaseDayDoc(d))
    .sort((a,b) => (a.date||"").localeCompare(b.date||""));
  const allDays = [...baseDays, ...extraDays];
  const ICONS=["⚓","⚙️","🎲","🚀","🏠","🍺","🌅","🌙","🎉","🗺"];
  const openEdit=day=>{setEditingId(day.id||day.short.replace(" ","_"));setEditForm({date:day.date,short:day.short,label:day.label,icon:day.icon||"⚓",notes:day.notes||"",activities:(day.activities||[]).join("\n")});};
  const saveDay=async day=>{const shortVal=(editForm.short.trim()||day.short);const id=day.id||shortVal.replace(/\s+/g,'_');await doSaveItinDay({id,date:(editForm.date.trim()||day.date),short:shortVal,label:(editForm.label.trim()||day.label),icon:(editForm.icon||day.icon),notes:editForm.notes.trim(),activities:editForm.activities.split('\n').map(a=>a.trim()).filter(Boolean)});showToast('Day updated! 🗓');setEditingId(null);};
  const addDay=async()=>{if(!form.date.trim()||!form.short.trim())return;const id=form.short.replace(/\s+/g,"_")+"_"+Date.now();await doSaveItinDay({id,date:form.date.trim(),short:form.short.trim(),label:form.label.trim()||"Day",icon:form.icon||"⚓",notes:form.notes.trim(),activities:form.activities.split("\n").map(a=>a.trim()).filter(Boolean)});showToast("Day added!");setShowAddDay(false);setForm({date:"",short:"",label:"",icon:"⚓",notes:"",activities:""});};
  return(<div>
    {/* Check-in / Check-out meta */}
    <Card style={{background:T.surface,border:`2px solid ${T.amber}44`,marginBottom:18}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:12,flexWrap:"wrap",gap:8}}>
        <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,letterSpacing:".04em"}}>🕐 Check-in / Check-out</h4>
        {metaDirty&&<Btn size="sm" onClick={saveMeta} disabled={metaSaving}>{metaSaving?"Saving…":"💾 Save"}</Btn>}
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(160px,1fr))",gap:12}}>
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:5}}>Check-in time</span>
          <input value={meta.checkIn} onChange={e=>{setMeta(m=>({...m,checkIn:e.target.value}));setMetaDirty(true);}}
            placeholder="e.g. 3 PM"
            style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"8px 10px",borderRadius:6,
              border:`2px solid ${T.border2}`,background:T.surface2,color:T.text,outline:"none",boxSizing:"border-box"}}/>
        </div>
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:5}}>Check-in day</span>
          <input value={meta.checkInDay} onChange={e=>{setMeta(m=>({...m,checkInDay:e.target.value}));setMetaDirty(true);}}
            placeholder="e.g. Thursday Nov 26"
            style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"8px 10px",borderRadius:6,
              border:`2px solid ${T.border2}`,background:T.surface2,color:T.text,outline:"none",boxSizing:"border-box"}}/>
        </div>
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:5}}>Check-out time</span>
          <input value={meta.checkOut} onChange={e=>{setMeta(m=>({...m,checkOut:e.target.value}));setMetaDirty(true);}}
            placeholder="e.g. 11 AM"
            style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"8px 10px",borderRadius:6,
              border:`2px solid ${T.border2}`,background:T.surface2,color:T.text,outline:"none",boxSizing:"border-box"}}/>
        </div>
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:5}}>Check-out day</span>
          <input value={meta.checkOutDay} onChange={e=>{setMeta(m=>({...m,checkOutDay:e.target.value}));setMetaDirty(true);}}
            placeholder="e.g. Sunday Nov 29"
            style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"8px 10px",borderRadius:6,
              border:`2px solid ${T.border2}`,background:T.surface2,color:T.text,outline:"none",boxSizing:"border-box"}}/>
        </div>
        <div style={{gridColumn:"1/-1"}}>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:5}}>Parking note</span>
          <input value={meta.parkingNote} onChange={e=>{setMeta(m=>({...m,parkingNote:e.target.value}));setMetaDirty(true);}}
            placeholder="e.g. Parking available on site"
            style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"8px 10px",borderRadius:6,
              border:`2px solid ${T.border2}`,background:T.surface2,color:T.text,outline:"none",boxSizing:"border-box"}}/>
        </div>
      </div>
    </Card>

    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14}}>
      <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber}}>🗓 Itinerary Days</h3>
      <Btn size="sm" onClick={()=>setShowAddDay(!showAddDay)}><i className="ti ti-plus"/> Add Day</Btn>
    </div>
    {showAddDay&&<Card style={{background:T.surface,border:`2px solid ${T.amber}55`,marginBottom:18}}>
      <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,marginBottom:12}}>New Itinerary Day</h4>
      <DayForm form={form} setForm={setForm} ICONS={ICONS}/>
      <div style={{display:"flex",gap:8,marginTop:12}}><Btn variant="ghost" size="sm" onClick={()=>setShowAddDay(false)}>Cancel</Btn><Btn size="sm" onClick={addDay} disabled={!form.date.trim()||!form.short.trim()}>Add Day</Btn></div>
    </Card>}
    <div style={{display:"flex",flexDirection:"column",gap:12}}>
      {allDays.map(day=>{const dayId=day.id||day.short.replace(" ","_");const isEditing=editingId===dayId;const isExtra=!COTTAGE_DAYS.find(b=>b.short===day.short);
        return<Card key={dayId} style={{background:T.surface,border:isEditing?`2px solid ${T.amber}88`:`2px solid ${T.border}`}}>
          {isEditing?(<>
            <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,marginBottom:12}}>Editing: {day.date}</h4>
            <DayForm form={editForm} setForm={setEditForm} ICONS={ICONS}/>
            <div style={{display:"flex",gap:8,marginTop:12,flexWrap:"wrap"}}>
              <Btn variant="ghost" size="sm" onClick={()=>setEditingId(null)}>Cancel</Btn>
              <Btn size="sm" onClick={()=>saveDay(day)}>Save Changes</Btn>
              {isExtra&&<Btn variant="danger" size="sm" onClick={async()=>{await doDelItinDay(dayId);showToast("Day removed.");}}><i className="ti ti-trash"/> Remove Day</Btn>}
            </div>
          </>):(
            <div style={{display:"flex",alignItems:"flex-start",gap:12}}>
              <div style={{fontSize:28,lineHeight:1,flexShrink:0,marginTop:2}}>{day.icon}</div>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:4}}>
                  <span style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber,fontWeight:700}}>{day.date}</span>
                  <span style={{fontSize:11,color:T.muted,background:T.surface2,padding:"2px 8px",borderRadius:3,border:`1px solid ${T.border}`}}>{day.label}</span>
                  {isExtra&&<span style={{fontSize:10,color:T.copper,border:`1px solid ${T.copper}44`,padding:"1px 6px",borderRadius:3,fontFamily:"'Cinzel',serif"}}>CUSTOM</span>}
                </div>
                {day.notes&&<p style={{fontSize:12,color:T.muted,marginBottom:6,fontStyle:"italic"}}>{day.notes}</p>}
                {day.activities?.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:5}}>{day.activities.map((a,ai)=><Chip key={ai} color="amber">{a}</Chip>)}</div>}
              </div>
              <button onClick={()=>openEdit(day)} style={{background:T.amberSoft,border:`1.5px solid ${T.border2}`,borderRadius:4,cursor:"pointer",color:T.amber,fontSize:13,padding:"5px 9px",flexShrink:0}}><i className="ti ti-pencil"/></button>
            </div>
          )}
        </Card>;
      })}
    </div>
  </div>);
}

function DayForm({form,setForm,ICONS}){
  const F=(k,v)=>setForm(p=>({...p,[k]:v}));
  return<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
    <Inp label="Full date *" placeholder="e.g. Thursday, Nov 26" value={form.date} onChange={e=>F("date",e.target.value)} containerStyle={{gridColumn:"1/-1"}}/>
    <Inp label="Short label *" placeholder="e.g. Nov 26" value={form.short} onChange={e=>F("short",e.target.value)}/>
    <Inp label="Day label" placeholder="e.g. Arrival Day" value={form.label} onChange={e=>F("label",e.target.value)}/>
    <div><span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:6}}>Icon</span>
      <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{ICONS.map(ic=><button key={ic} onClick={()=>F("icon",ic)} style={{fontSize:20,padding:"4px 6px",borderRadius:4,border:`2px solid ${form.icon===ic?T.amber:T.border}`,background:form.icon===ic?T.amberSoft:"transparent",cursor:"pointer"}}>{ic}</button>)}</div>
    </div>
    <Inp label="Notes / description" placeholder="e.g. Check-in from 3 PM" value={form.notes} onChange={e=>F("notes",e.target.value)} containerStyle={{gridColumn:"1/-1"}}/>
    <div style={{gridColumn:"1/-1"}}>
      <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:6}}>Activities (one per line)</span>
      <textarea value={form.activities} onChange={e=>F("activities",e.target.value)} placeholder={"🚂 Arrivals\n🎲 Evening games\n🍺 Welcome drinks"} style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"9px 12px",borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,color:T.text,outline:"none",resize:"vertical",minHeight:80}}/>
    </div>
  </div>;
}

// ── Deck Slot Editor ──────────────────────────────────────────────────────────
// ── SlotRow — must be outside DeckSlotEditor to preserve input focus on re-render
function SlotRow({slot, editId, editTask, editType, setEditId, setEditTask, setEditType, saveEdit, clearClaim, doDelDeckSlot, showToast}){
  const isEditing = editId === slot.id;
  const claimed   = !!slot.claimedBy;
  return (
    <div style={{display:"flex",alignItems:"center",gap:8,padding:"9px 12px",background:T.surface,
      border:`1.5px solid ${slot.type==="prep"?T.steam+"44":T.copper+"44"}`,borderRadius:7,marginBottom:7}}>
      {isEditing ? (
        <div style={{flex:1,display:"flex",gap:8,flexWrap:"wrap",alignItems:"center"}}>
          <input
            autoFocus
            value={editTask}
            onChange={e=>setEditTask(e.target.value)}
            onKeyDown={e=>{ if(e.key==="Enter") saveEdit(slot); if(e.key==="Escape") setEditId(null); }}
            style={{flex:1,minWidth:120,fontFamily:"inherit",fontSize:13,padding:"5px 9px",
              borderRadius:5,border:`2px solid ${T.border2}`,background:T.surface2,color:T.text,outline:"none"}}
          />
          <div style={{display:"flex",gap:5}}>
            {[["prep","⚙️ Prep"],["cleanup","🧹 Cleanup"]].map(([v,l])=>(
              <button key={v} onClick={()=>setEditType(v)}
                style={{fontFamily:"'Cinzel',serif",fontSize:10,padding:"3px 8px",borderRadius:3,
                  border:`1.5px solid ${editType===v?T.amber:T.border}`,
                  background:editType===v?T.amberSoft:"transparent",
                  color:editType===v?T.amber:T.muted,cursor:"pointer"}}>{l}</button>
            ))}
          </div>
          <div style={{display:"flex",gap:5}}>
            <button onClick={()=>setEditId(null)}
              style={{fontFamily:"'Cinzel',serif",fontSize:11,padding:"4px 10px",borderRadius:4,
                border:`1.5px solid ${T.border}`,background:"transparent",color:T.muted,cursor:"pointer"}}>
              Cancel
            </button>
            <button onClick={()=>saveEdit(slot)}
              style={{fontFamily:"'Cinzel',serif",fontSize:11,padding:"4px 10px",borderRadius:4,
                border:`1.5px solid ${T.amber}`,background:T.amberSoft,color:T.amber,cursor:"pointer",fontWeight:700}}>
              Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <span style={{fontSize:14,flexShrink:0}}>{slot.type==="prep"?"⚙️":"🧹"}</span>
          <div style={{flex:1,minWidth:0}}>
            <span style={{fontSize:13,color:T.text,fontWeight:500}}>{slot.task}</span>
            {claimed&&<div style={{fontSize:11,color:T.hint,marginTop:2}}>
              Assigned: <span style={{color:slot.type==="prep"?T.steam:T.copper,fontWeight:600}}>{slot.claimedByName||"crew"}</span>
            </div>}
          </div>
          <div style={{display:"flex",gap:5,flexShrink:0}}>
            {claimed&&<button onClick={()=>clearClaim(slot)}
              style={{background:T.surface2,border:`1.5px solid ${T.border}`,borderRadius:4,cursor:"pointer",color:T.hint,fontSize:12,padding:"4px 7px"}}>✕</button>}
            <button onClick={()=>{setEditId(slot.id);setEditTask(slot.task);setEditType(slot.type);}}
              style={{background:T.amberSoft,border:`1.5px solid ${T.border2}`,borderRadius:4,cursor:"pointer",color:T.amber,fontSize:13,padding:"4px 7px"}}>
              <i className="ti ti-pencil"/>
            </button>
            <button onClick={async()=>{await doDelDeckSlot(slot.id);showToast("Slot removed.");}}
              style={{background:T.dangerBg,border:`1.5px solid ${T.danger}44`,borderRadius:4,cursor:"pointer",color:T.danger,fontSize:13,padding:"4px 7px"}}>
              <i className="ti ti-trash"/>
            </button>
          </div>
        </>
      )}
    </div>
  );
}

function DeckSlotEditor({ctx}){
  const {deckHands,showToast,doSaveDeckSlot,doDelDeckSlot,doInitDeckHands}=ctx;
  const [activeDay,setActiveDay]=useState("Nov 26");
  const [showAdd,setShowAdd]=useState(false);
  const [addType,setAddType]=useState("prep");
  const [addTask,setAddTask]=useState("");
  const [editId,setEditId]=useState(null);
  const [editTask,setEditTask]=useState("");
  const [editType,setEditType]=useState("prep");
  const slots=Object.values(deckHands);
  const slotsForDay=(day,type)=>slots.filter(s=>s.day===day&&s.type===type).sort((a,b)=>a.task.localeCompare(b.task));
  const displayDays=[...new Set([...COTTAGE_DAYS.map(d=>d.short),...slots.map(s=>s.day)])];
  const addSlot=async()=>{if(!addTask.trim())return;const id=`${addType}_${activeDay.replace(" ","")}${Date.now()}`;await doSaveDeckSlot({id,day:activeDay,type:addType,task:addTask.trim(),claimedBy:null,claimedByName:""});showToast("Slot added!");setAddTask("");setShowAdd(false);};
  const saveEdit=async slot=>{await doSaveDeckSlot({...slot,task:editTask.trim(),type:editType});showToast("Slot updated!");setEditId(null);};
  const clearClaim=async slot=>{await doSaveDeckSlot({...slot,claimedBy:null,claimedByName:""});showToast("Assignment cleared.");};
  // SlotRow is defined outside this component to prevent focus loss on re-render
  return<div>
    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:14,flexWrap:"wrap",gap:8}}>
      <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber}}>⚙️ Deck Hand Slots</h3>
      <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
        <Btn variant="ghost" size="sm" onClick={async()=>{await doInitDeckHands();showToast("Default slots restored!");}}><i className="ti ti-refresh"/> Restore Defaults</Btn>
        <Btn size="sm" onClick={()=>setShowAdd(!showAdd)}><i className="ti ti-plus"/> Add Slot</Btn>
      </div>
    </div>
    {showAdd&&<Card style={{background:T.surface,border:`2px solid ${T.amber}55`,marginBottom:18}}>
      <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,marginBottom:12}}>New Duty Slot</h4>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:12}}>
        <div><span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:6}}>Day</span>
          <select value={activeDay} onChange={e=>setActiveDay(e.target.value)} style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"8px 10px",borderRadius:5,border:`2px solid ${T.border2}`,background:T.surface2,color:T.text,outline:"none"}}>
            {displayDays.map(d=><option key={d}>{d}</option>)}</select>
        </div>
        <div><span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:6}}>Type</span>
          <div style={{display:"flex",gap:6}}>{[["prep","⚙️ Prep"],["cleanup","🧹 Cleanup"]].map(([v,l])=><button key={v} onClick={()=>setAddType(v)} style={{flex:1,fontFamily:"'Cinzel',serif",fontSize:11,padding:"7px 0",borderRadius:5,border:`2px solid ${addType===v?T.amber:T.border}`,background:addType===v?T.amberSoft:"transparent",color:addType===v?T.amber:T.muted,cursor:"pointer",fontWeight:700}}>{l}</button>)}</div>
        </div>
        <Inp label="Task description *" placeholder={addType==="prep"?"e.g. Grocery run":"e.g. Dishes & kitchen"} value={addTask} onChange={e=>setAddTask(e.target.value)} containerStyle={{gridColumn:"1/-1"}}/>
      </div>
      <div style={{display:"flex",gap:8}}><Btn variant="ghost" size="sm" onClick={()=>setShowAdd(false)}>Cancel</Btn><Btn size="sm" onClick={addSlot} disabled={!addTask.trim()}>Add Slot</Btn></div>
    </Card>}
    <div style={{display:"flex",gap:6,marginBottom:14,flexWrap:"wrap"}}>
      {displayDays.map(d=><button key={d} onClick={()=>setActiveDay(d)} style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,padding:"6px 13px",borderRadius:5,border:`2px solid ${activeDay===d?T.amber:T.border}`,cursor:"pointer",background:activeDay===d?T.amberSoft:"transparent",color:activeDay===d?T.amber:T.muted,transition:"all .15s"}}>{d}</button>)}
    </div>
    {(()=>{const prep=slotsForDay(activeDay,"prep"),clean=slotsForDay(activeDay,"cleanup"),total=prep.length+clean.length,claimed=[...prep,...clean].filter(s=>s.claimedBy).length;
      return<div style={{display:"flex",gap:8,marginBottom:14,flexWrap:"wrap"}}>
        <span style={{fontSize:12,color:T.muted,background:T.surface2,border:`1px solid ${T.border}`,borderRadius:4,padding:"4px 10px",fontFamily:"'Cinzel',serif"}}>{total} slots total</span>
        <span style={{fontSize:12,color:claimed===total&&total>0?T.steam:T.copper,background:T.surface2,border:`1px solid ${T.border}`,borderRadius:4,padding:"4px 10px",fontFamily:"'Cinzel',serif"}}>{claimed}/{total} assigned</span>
      </div>;})()}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(280px,1fr))",gap:16}}>
      <div><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}><span style={{fontSize:14}}>⚙️</span><span style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.steam,fontWeight:700}}>Preparation</span><span style={{fontSize:11,color:T.hint}}>({slotsForDay(activeDay,"prep").length})</span></div>
        {slotsForDay(activeDay,"prep").length===0?<div style={{fontSize:12,color:T.hint,fontStyle:"italic",padding:"10px 0"}}>No prep slots for this day.</div>:slotsForDay(activeDay,"prep").map(s=><SlotRow key={s.id} slot={s} editId={editId} editTask={editTask} editType={editType} setEditId={setEditId} setEditTask={setEditTask} setEditType={setEditType} saveEdit={saveEdit} clearClaim={clearClaim} doDelDeckSlot={doDelDeckSlot} showToast={showToast}/>)}
      </div>
      <div><div style={{display:"flex",alignItems:"center",gap:6,marginBottom:10}}><span style={{fontSize:14}}>🧹</span><span style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.copper,fontWeight:700}}>Cleanup</span><span style={{fontSize:11,color:T.hint}}>({slotsForDay(activeDay,"cleanup").length})</span></div>
        {slotsForDay(activeDay,"cleanup").length===0?<div style={{fontSize:12,color:T.hint,fontStyle:"italic",padding:"10px 0"}}>No cleanup slots for this day.</div>:slotsForDay(activeDay,"cleanup").map(s=><SlotRow key={s.id} slot={s} editId={editId} editTask={editTask} editType={editType} setEditId={setEditId} setEditTask={setEditTask} setEditType={setEditType} saveEdit={saveEdit} clearClaim={clearClaim} doDelDeckSlot={doDelDeckSlot} showToast={showToast}/>)}
      </div>
    </div>
  </div>;
}

// ── Deposit Manager (Engine Room only) ───────────────────────────────────────
function DepositManager({ctx}){
  const {users,doSetDeposit}=ctx;
  const uList=Object.values(users).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const paid=uList.filter(u=>u.deposit);
  const pending=uList.filter(u=>!u.deposit);

  return(
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber}}>💰 Deposit Tracker</h3>
        <div style={{display:"flex",gap:8}}>
          <span style={{fontSize:12,color:"#4ADE80",background:"#162A1E",border:"1px solid #166534",borderRadius:4,padding:"3px 10px",fontFamily:"'Cinzel',serif",fontWeight:700}}>
            {paid.length} paid
          </span>
          <span style={{fontSize:12,color:T.danger,background:"#1A0E0E",border:"1px solid #991B1B",borderRadius:4,padding:"3px 10px",fontFamily:"'Cinzel',serif",fontWeight:700}}>
            {pending.length} pending
          </span>
        </div>
      </div>
      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {uList.map(u=>{
          const rank=CREW_RANKS[u.crewRank||"Enlisted"]||CREW_RANKS["Enlisted"];
          const hasPaid=!!u.deposit;
          return(
            <div key={u.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",
              background:hasPaid?T.amberSoft:T.surface2,
              border:`2px solid ${hasPaid?T.amber:T.border2}`,
              borderRadius:8,transition:"all .2s"}}>
              <Avatar name={u.name} picture={u.picture} size={40}/>
              <div style={{flex:1,minWidth:0}}>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span style={{fontWeight:600,fontSize:13,color:T.text}}>{u.name}</span>
                  <span style={{fontSize:10,padding:"1px 6px",borderRadius:3,background:rank.bg,color:rank.text,border:`1px solid ${rank.border}`,fontFamily:"'Cinzel',serif",fontWeight:700}}>
                    {rank.icon} {u.crewRank||"Enlisted"}
                  </span>
                </div>
                <div style={{fontSize:11,color:hasPaid?T.amberGlow:T.hint,marginTop:2,fontFamily:"'Cinzel',serif",fontWeight:hasPaid?700:400}}>
                  {hasPaid?"💰 Deposit received":"⏳ Awaiting deposit"}
                </div>
              </div>
              {/* Toggle button — engine room only */}
              <button
                onClick={()=>doSetDeposit(u.id,!hasPaid)}
                title={hasPaid?"Mark as not paid":"Mark as paid"}
                style={{
                  fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,
                  padding:"6px 14px",borderRadius:5,cursor:"pointer",flexShrink:0,
                  border:`2px solid ${hasPaid?T.amber:"#166534"}`,
                  background:hasPaid?T.amberSoft:"#0A2010",
                  color:hasPaid?T.amberGlow:"#4ADE80",
                  transition:"all .15s",
                  boxShadow:hasPaid?`0 0 8px ${T.amber}33`:`0 0 8px #4ADE8033`,
                }}>
                {hasPaid?"✓ Paid":"Mark Paid"}
              </button>
            </div>
          );
        })}
        {uList.length===0&&<p style={{color:T.hint,fontSize:13,textAlign:"center",padding:"20px 0",fontStyle:"italic"}}>No crew registered yet.</p>}
      </div>
    </div>
  );
}

// ── Crew Rank Manager (Engine Room only) ─────────────────────────────────────
function CrewRankManager({ctx}){
  const {users, doSetRank} = ctx;
  const uList = Object.values(users).sort((a,b)=>(a.name||"").localeCompare(b.name||""));

  // Summary counts
  const counts = Object.fromEntries(Object.keys(CREW_RANKS).map(r=>[r, uList.filter(u=>(u.crewRank||"Enlisted")===r).length]));

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber}}>⚓ Crew Rank Manager</h3>
        <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
          {Object.entries(CREW_RANKS).map(([r,rc])=>(
            <span key={r} style={{fontSize:11,padding:"3px 9px",borderRadius:4,fontFamily:"'Cinzel',serif",fontWeight:700,
              background:rc.bg,color:rc.text,border:`1px solid ${rc.border}`}}>
              {rc.icon} {r}: {counts[r]||0}
            </span>
          ))}
        </div>
      </div>

      <div style={{display:"flex",flexDirection:"column",gap:8}}>
        {uList.map(u=>{
          const currentRank = u.crewRank||"Enlisted";
          const rc = CREW_RANKS[currentRank]||CREW_RANKS["Enlisted"];
          return (
            <div key={u.id} style={{display:"flex",alignItems:"center",gap:12,padding:"10px 14px",
              background:T.surface2,border:`2px solid ${rc.border}55`,borderRadius:8,
              flexWrap:"wrap",transition:"all .2s"}}>
              <Avatar name={u.name} picture={u.picture} size={40}/>
              <div style={{flex:1,minWidth:140}}>
                <div style={{fontWeight:600,fontSize:13,color:T.text,marginBottom:2}}>{u.name}</div>
                <div style={{fontSize:11,color:T.hint}}>{u.email||""}</div>
              </div>
              {/* Rank selector buttons */}
              <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
                {Object.entries(CREW_RANKS).map(([r,rc2])=>{
                  const active = currentRank===r;
                  return (
                    <button key={r} onClick={()=>!active&&doSetRank(u.id,r)}
                      style={{fontFamily:"'Cinzel',serif",fontSize:11,fontWeight:700,
                        padding:"5px 11px",borderRadius:4,cursor:active?"default":"pointer",
                        border:`2px solid ${active?rc2.border:T.border}`,
                        background:active?rc2.bg:"transparent",
                        color:active?rc2.text:T.muted,
                        transition:"all .15s",
                        display:"inline-flex",alignItems:"center",gap:4,
                        boxShadow:active?`0 0 8px ${rc2.glow}55`:undefined,
                        opacity:active?1:.7}}>
                      <span style={{fontSize:14}}>{rc2.icon}</span>{r}
                    </button>
                  );
                })}
              </div>
            </div>
          );
        })}
        {uList.length===0&&<p style={{color:T.hint,fontSize:13,textAlign:"center",padding:"20px 0",fontStyle:"italic"}}>No crew registered yet.</p>}
      </div>
    </div>
  );
}

// ── Notify Panel (Engine Room) ────────────────────────────────────────────────
function NotifyPanel({ctx}){
  const {users, doSendNotification} = ctx;

  const [title,     setTitle]     = useState("");
  const [body,      setBody]       = useState("");
  const [target,    setTarget]     = useState("all"); // "all" | "select"
  const [selected,  setSelected]   = useState([]);
  const [sending,   setSending]    = useState(false);
  const [result,    setResult]     = useState(null);

  const uList = Object.values(users).sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  const registeredUsers = uList.filter(u=>u.fcmToken);
  const unregisteredUsers = uList.filter(u=>!u.fcmToken);

  const toggleUser = id => setSelected(p => p.includes(id) ? p.filter(x=>x!==id) : [...p, id]);

  const selectedTokens = selected.map(id=>users[id]?.fcmToken).filter(Boolean);
  const canSend = title.trim() && (target==="all" ? registeredUsers.length > 0 : selectedTokens.length > 0);

  const send = async () => {
    if(!canSend) return;
    setSending(true); setResult(null);
    const res = await doSendNotification({
      title: title.trim(),
      body:  body.trim(),
      targetAll:    target === "all",
      targetTokens: target === "select" ? selectedTokens : [],
    });
    setResult(res);
    setSending(false);
    if(res?.sent > 0){ setTitle(""); setBody(""); setSelected([]); }
  };

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16,flexWrap:"wrap",gap:8}}>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber}}>📨 Send Notification</h3>
        <div style={{display:"flex",gap:6}}>
          <span style={{fontSize:12,color:"#4ADE80",background:"#162A1E",border:"1px solid #166534",borderRadius:4,padding:"3px 10px",fontFamily:"'Cinzel',serif",fontWeight:700}}>
            {registeredUsers.length} device{registeredUsers.length!==1?"s":""}
          </span>
          {unregisteredUsers.length>0&&<span style={{fontSize:12,color:T.hint,background:T.surface2,border:`1px solid ${T.border}`,borderRadius:4,padding:"3px 10px",fontFamily:"'Cinzel',serif"}}>
            {unregisteredUsers.length} unregistered
          </span>}
        </div>
      </div>

      {/* Compose card */}
      <Card style={{background:T.bgMid,marginBottom:14}}>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          <Inp
            label="Notification title *"
            placeholder="e.g. Dinner is ready! 🍲"
            value={title}
            onChange={e=>setTitle(e.target.value)}
          />
          <div>
            <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:6}}>Message body</span>
            <textarea
              value={body}
              onChange={e=>setBody(e.target.value)}
              placeholder="Optional — extra detail shown below the title on the device"
              style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"9px 12px",
                borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,
                color:T.text,outline:"none",resize:"vertical",minHeight:72,lineHeight:1.5}}
            />
          </div>
        </div>
      </Card>

      {/* Target selector */}
      <Card style={{background:T.bgMid,marginBottom:14}}>
        <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:10}}>Send to</span>
        <div style={{display:"flex",gap:8,marginBottom:12}}>
          {[["all","📢 All crew"],["select","👤 Select crew"]].map(([v,l])=>(
            <button key={v} onClick={()=>{ setTarget(v); setSelected([]); }}
              style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"7px 16px",borderRadius:5,
                cursor:"pointer",border:`2px solid ${target===v?T.amber:T.border}`,
                background:target===v?T.amberSoft:"transparent",color:target===v?T.amber:T.muted,transition:"all .15s"}}>
              {l}
            </button>
          ))}
        </div>

        {/* Crew list */}
        <div style={{display:"flex",flexDirection:"column",gap:6,maxHeight:280,overflowY:"auto"}}>
          {uList.map(u=>{
            const hasToken = !!u.fcmToken;
            const rank = CREW_RANKS[u.crewRank||"Enlisted"]||CREW_RANKS["Enlisted"];
            const isSelected = selected.includes(u.id);
            const isAll = target==="all";

            return (
              <div key={u.id}
                onClick={()=>hasToken&&target==="select"&&toggleUser(u.id)}
                style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",
                  background: isAll&&hasToken ? "#162A1E" : isSelected ? T.amberSoft : T.surface,
                  border:`1.5px solid ${isAll&&hasToken?"#166534":isSelected?T.amber:T.border}`,
                  borderRadius:7,cursor:hasToken&&target==="select"?"pointer":"default",
                  opacity:hasToken?1:.5,transition:"all .15s"}}>
                <Avatar name={u.name} picture={u.picture} size={36}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                    <span style={{fontSize:13,fontWeight:600,color:T.text}}>{u.name}</span>
                    <span style={{fontSize:10,padding:"1px 5px",borderRadius:3,background:rank.bg,color:rank.text,
                      border:`1px solid ${rank.border}`,fontFamily:"'Cinzel',serif",fontWeight:700}}>
                      {rank.icon}
                    </span>
                  </div>
                  <div style={{fontSize:11,color:hasToken?"#4ADE80":T.hint,marginTop:1}}>
                    {hasToken?"📱 Device registered":"No device registered"}
                  </div>
                </div>
                {/* State indicator */}
                {isAll&&hasToken&&<span style={{fontSize:16}}>✓</span>}
                {target==="select"&&hasToken&&(
                  <div style={{width:20,height:20,borderRadius:4,border:`2px solid ${isSelected?T.amber:T.border}`,
                    background:isSelected?T.amber:"transparent",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>
                    {isSelected&&<span style={{fontSize:12,color:T.bg,fontWeight:700,lineHeight:1}}>✓</span>}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* Preview */}
      {title.trim()&&(
        <Card style={{background:"#111827",border:`1.5px dashed ${T.border2}`,marginBottom:14}}>
          <div style={{fontSize:10,color:T.hint,fontFamily:"'Cinzel',serif",letterSpacing:".06em",marginBottom:8,textTransform:"uppercase"}}>Preview</div>
          <div style={{display:"flex",gap:10,alignItems:"flex-start"}}>
            <div style={{width:36,height:36,borderRadius:8,background:"#253044",border:`1px solid ${T.border2}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:20,flexShrink:0}}>⚙️</div>
            <div>
              <div style={{fontSize:13,fontWeight:700,color:T.text,marginBottom:2}}>Cottage Con · {title}</div>
              {body&&<div style={{fontSize:12,color:T.muted,lineHeight:1.4}}>{body}</div>}
              <div style={{fontSize:10,color:T.hint,marginTop:4}}>now</div>
            </div>
          </div>
        </Card>
      )}

      {/* Result banner */}
      {result&&<div style={{padding:"10px 14px",borderRadius:7,marginBottom:14,
        background:result.sent>0?"#162A1E":"#1A0E0E",
        border:`1.5px solid ${result.sent>0?"#166534":"#991B1B"}`,
        color:result.sent>0?"#4ADE80":T.danger,fontSize:13,fontFamily:"'Cinzel',serif"}}>
        {result.sent>0
          ? `✓ Queued for ${result.sent} device${result.sent!==1?"s":""}. Notification ID: ${result.notifId?.slice(0,8)}…`
          : "⚠️ No registered devices — ask crew to enable notifications in their Personal Log."}
      </div>}

      {/* Send button */}
      <Btn
        onClick={send}
        disabled={!canSend||sending}
        style={{width:"100%",fontSize:14,opacity:canSend&&!sending?1:.5}}>
        {sending
          ? "⏳ Sending…"
          : `📨 Send to ${target==="all"?`all ${registeredUsers.length} device${registeredUsers.length!==1?"s":""}`:selectedTokens.length+" device"+( selectedTokens.length!==1?"s":"")}`}
      </Btn>

      {!canSend&&!title.trim()&&<p style={{fontSize:11,color:T.hint,textAlign:"center",marginTop:8}}>Enter a title to enable sending.</p>}
      {!canSend&&title.trim()&&target==="select"&&!selectedTokens.length&&(
        <p style={{fontSize:11,color:T.hint,textAlign:"center",marginTop:8}}>Select at least one crew member with a registered device.</p>
      )}

      {/* Cloud Function note */}
      <div style={{marginTop:16,padding:"10px 14px",borderRadius:7,background:T.surface2,border:`1px solid ${T.border}`}}>
        <div style={{fontSize:11,color:T.hint,lineHeight:1.6}}>
          <strong style={{color:T.muted,fontFamily:"'Cinzel',serif"}}>ℹ️ Delivery</strong> — Notifications are queued in Firestore.
          For background delivery to closed apps, deploy a Firebase Cloud Function that watches the <code style={{background:T.bg,padding:"1px 5px",borderRadius:3}}>notifications</code> collection
          and calls the FCM HTTP v1 API. In-app delivery (app open) works immediately via the live listener.
        </div>
      </div>
    </div>
  );
}

// ── Game Recommender (Gemini-powered) ─────────────────────────────────────────
function GameRecommender({games, users, profile, food}){
  const [playerCount, setPlayerCount] = useState("4");
  const [mood,        setMood]        = useState("");
  const [duration,    setDuration]    = useState("");
  const [experience,  setExperience]  = useState("");
  const [loading,     setLoading]     = useState(false);
  const [result,      setResult]      = useState(null);
  const [error,       setError]       = useState(null);
  const [history,     setHistory]     = useState([]); // for follow-up questions
  const [followUp,    setFollowUp]    = useState("");
  const [asking,      setAsking]      = useState(false);

  const uList   = Object.values(users);
  const allDiets= [...new Set(uList.flatMap(u=>u.dietary||[]))];

  const buildPrompt = () => {
    const gameList = games.map(g=>{
      const parts = [g.name];
      if(g.category) parts.push(`(${g.category})`);
      if(g.minPlayers||g.maxPlayers) parts.push(`${g.minPlayers||"?"}–${g.maxPlayers||"?"}p`);
      if(g.likes?.length) parts.push(`${g.likes.length}⭐`);
      return parts.join(" ");
    }).join(", ");

    return `We are at a board game cottage weekend (Nov 26-29, Alliston ON). Here's our situation:

- Players joining this session: ${playerCount}
- Total crew registered: ${uList.length} people
- Dietary restrictions in the group: ${allDiets.length ? allDiets.join(", ") : "none"}
- Mood / vibe we want: ${mood || "no preference"}
- Time available: ${duration || "flexible"}
- Player experience level: ${experience || "mixed"}

Games available at the cottage:
${gameList || "none loaded yet"}

ONLY recommend games from the list above — never suggest games not in it. Recommend the top 3 and explain why each fits this group right now (1 sentence each). One quick tip per game. Be concise.`;
  };

  const getRecommendation = async () => {
    if(!games.length){
      setError("No games in the Cargo Hold yet! Add some games first.");
      return;
    }
    setLoading(true); setResult(null); setError(null); setHistory([]);
    try {
      const prompt = buildPrompt();
      const text = await askGemini(prompt);
      setResult(text);
      setHistory([
        {role:"user",  parts:[{text:prompt}]},
        {role:"model", parts:[{text}]},
      ]);
    } catch(e) {
      console.error("Gemini error:", e);
      setError(e.message || "The assistant encountered an error. Check your Firebase AI setup.");
    }
    setLoading(false);
  };

  const sendFollowUp = async () => {
    if(!followUp.trim()||!history.length) return;
    setAsking(true);
    const q = followUp.trim();
    setFollowUp("");
    try {
      const reply = await askGemini(q, history);
      setResult(reply);
      setHistory(h=>[...h,
        {role:"user",  parts:[{text:q}]},
        {role:"model", parts:[{text:reply}]},
      ]);
    } catch(e) {
      setError(e.message || "Follow-up failed. Try again.");
    }
    setAsking(false);
  };

  const MOODS    = ["🎉 Party vibes","🧠 Strategic","😂 Silly & fun","⚔️ Competitive","🤝 Cooperative","🎲 Quick & casual","🏆 Epic campaign"];
  const DURATIONS= ["⚡ Under 30 min","🕐 30–60 min","🕑 1–2 hours","🕒 2+ hours"];
  const LEVELS   = ["👶 Complete beginners","🔰 Some experience","🎯 Regular gamers","⚓ Hardcore veterans","🌊 Total mix"];

  return (
    <Card style={{background:T.bgMid,border:`2.5px solid ${T.steam}66`,marginBottom:20,overflow:"hidden"}}>
      {/* Header */}
      <div style={{position:"absolute",top:0,left:0,right:0,height:3,background:`linear-gradient(90deg,transparent,${T.steam},transparent)`}}/>
      <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:18}}>
        <span style={{fontSize:28,filter:`drop-shadow(0 0 8px ${T.steam}88)`}}>🤖</span>
        <div>
          <h3 style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.steam,fontWeight:700,letterSpacing:".04em",marginBottom:2}}>
            Game Recommender
          </h3>
          <p style={{fontSize:12,color:T.muted}}>Powered by Gemini — tells you what to play right now</p>
        </div>
      </div>

      {/* Controls */}
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12,marginBottom:16}}>
        {/* Player count */}
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:6}}>Players this session</span>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {["2","3","4","5","6","7","8+"].map(n=>(
              <button key={n} onClick={()=>setPlayerCount(n)}
                style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"5px 11px",borderRadius:4,
                  border:`2px solid ${playerCount===n?T.steam:T.border}`,cursor:"pointer",
                  background:playerCount===n?T.steamSoft:"transparent",color:playerCount===n?T.steam:T.muted,
                  transition:"all .15s"}}>
                {n}
              </button>
            ))}
          </div>
        </div>

        {/* Duration */}
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:6}}>Time available</span>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {DURATIONS.map(d=>(
              <button key={d} onClick={()=>setDuration(duration===d?"":d)}
                style={{fontFamily:"inherit",fontSize:11,padding:"5px 10px",borderRadius:4,
                  border:`2px solid ${duration===d?T.steam:T.border}`,cursor:"pointer",
                  background:duration===d?T.steamSoft:"transparent",color:duration===d?T.steam:T.muted,
                  transition:"all .15s",whiteSpace:"nowrap"}}>
                {d}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(200px,1fr))",gap:12,marginBottom:18}}>
        {/* Mood */}
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:6}}>Mood / vibe</span>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {MOODS.map(m=>(
              <button key={m} onClick={()=>setMood(mood===m?"":m)}
                style={{fontFamily:"inherit",fontSize:11,padding:"5px 10px",borderRadius:4,
                  border:`2px solid ${mood===m?T.steam:T.border}`,cursor:"pointer",
                  background:mood===m?T.steamSoft:"transparent",color:mood===m?T.steam:T.muted,
                  transition:"all .15s",whiteSpace:"nowrap"}}>
                {m}
              </button>
            ))}
          </div>
        </div>

        {/* Experience */}
        <div>
          <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",letterSpacing:".06em",display:"block",marginBottom:6}}>Experience level</span>
          <div style={{display:"flex",gap:5,flexWrap:"wrap"}}>
            {LEVELS.map(l=>(
              <button key={l} onClick={()=>setExperience(experience===l?"":l)}
                style={{fontFamily:"inherit",fontSize:11,padding:"5px 10px",borderRadius:4,
                  border:`2px solid ${experience===l?T.steam:T.border}`,cursor:"pointer",
                  background:experience===l?T.steamSoft:"transparent",color:experience===l?T.steam:T.muted,
                  transition:"all .15s",whiteSpace:"nowrap"}}>
                {l}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Ask button */}
      <button onClick={getRecommendation} disabled={loading}
        style={{width:"100%",fontFamily:"'Cinzel',serif",fontSize:14,fontWeight:700,
          padding:"12px 0",borderRadius:6,cursor:loading?"wait":"pointer",
          border:`2px solid ${T.steam}`,background:loading?T.surface:T.steamSoft,
          color:T.steam,transition:"all .2s",
          boxShadow:loading?undefined:`0 0 16px ${T.steam}44`,
          opacity:loading?.7:1}}>
        {loading
          ? <span style={{display:"flex",alignItems:"center",justifyContent:"center",gap:8}}>
              <span style={{display:"inline-block",animation:"ccSpin 1s linear infinite",fontSize:16}}>⚙️</span>
              Consulting the Gemini oracle…
            </span>
          : "⚙️ What Should We Play?"}
      </button>

      {/* Error */}
      {error&&<div style={{marginTop:14,padding:"12px 16px",borderRadius:7,
        background:T.dangerBg,border:`1.5px solid ${T.danger}44`,color:T.danger,fontSize:13,lineHeight:1.6}}>
        <div style={{fontWeight:700,marginBottom:6}}>⚠️ AI Error</div>
        <div>{error}</div>
      </div>}

      {/* Result */}
      {result&&<div style={{marginTop:16}}>
        <div style={{position:"relative",background:T.surface,border:`2px solid ${T.steam}44`,borderRadius:8,padding:"16px 18px",
          fontSize:14,color:T.text,lineHeight:1.75,whiteSpace:"pre-wrap",wordBreak:"break-word"}}>
          <div style={{position:"absolute",top:-1,left:20,background:T.bgMid,padding:"0 8px",
            fontFamily:"'Cinzel',serif",fontSize:10,color:T.steam,fontWeight:700,letterSpacing:".06em"}}>
            ⚙️ GEMINI RECOMMENDS
          </div>
          {result}
        </div>

        {/* Follow-up */}
        <div style={{marginTop:10,display:"flex",gap:8}}>
          <input
            value={followUp}
            onChange={e=>setFollowUp(e.target.value)}
            onKeyDown={e=>e.key==="Enter"&&!asking&&sendFollowUp()}
            placeholder="Ask a follow-up… e.g. 'Can we play that with kids?'"
            style={{flex:1,fontFamily:"inherit",fontSize:13,padding:"8px 12px",
              borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,
              color:T.text,outline:"none"}}
          />
          <button onClick={sendFollowUp} disabled={!followUp.trim()||asking}
            style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,
              padding:"8px 14px",borderRadius:6,cursor:"pointer",flexShrink:0,
              border:`2px solid ${T.steam}`,background:T.steamSoft,color:T.steam,
              opacity:(!followUp.trim()||asking)?.5:1,transition:"all .15s"}}>
            {asking?"…":"Ask"}
          </button>
        </div>
        <div style={{marginTop:8,textAlign:"right"}}>
          <button onClick={()=>{setResult(null);setHistory([]);setError(null);}}
            style={{background:"none",border:"none",cursor:"pointer",fontSize:11,color:T.hint,
              fontFamily:"'Cinzel',serif",textDecoration:"underline"}}>
            Start over
          </button>
        </div>
      </div>}
    </Card>
  );
}

// ── Crew Assistant Chatbot ────────────────────────────────────────────────────
// A title pulled out of a question can still carry lead-in words ("the rules for Azul"). Strip them so the
// lookup and any BGG search link use the game's name only.
export function cleanAskedTitle(s = "") {
  let t = String(s).trim();
  const LEAD = /^(?:(?:the|a|an|some)\s+)?(?:rules?|instructions?|directions?|details?|info(?:rmation)?|how\s+to\s+play|play(?:ing)?|explain(?:ing)?|teach(?:ing)?|about)\s+(?:(?:for|of|on|about|to)\s+)?/i;
  for (let i = 0; i < 3 && LEAD.test(t); i++) t = t.replace(LEAD, "");
  return t.replace(/^(?:the\s+game\s+|game\s+)/i, "").trim();
}

// ── Chat ↔ BoardGameGeek helpers ───────────────────────────────────────────────
// Context block telling the chat model exactly which BoardGameGeek facts are VERIFIED for a game.
// `result` is matcher.find(asked). Only index-backed data is ever presented as fact or given as a link.
export function bggFactsBlock(result, asked) {
  const search = bggSearchUrl(asked);
  if(result.status === "exact"){
    const g = result.match;
    return `=== BOARDGAMEGEEK: "${g.name}" (verified in BGG's database) ===
Year: ${g.year || "unknown"} | BGG average rating: ${g.rating}/10 from ${Number(g.ratings).toLocaleString("en-US")} ratings
BGG link: ${bggGameUrl(g.id)}
Include this exact BGG link when you answer about this game. Year and rating may only be stated as given here.`;
  }
  if(result.status === "fuzzy"){
    return `=== BOARDGAMEGEEK: no exact match for "${asked}" ===
Possible matches (NOT confirmed): ${result.candidates.map(c => `${c.name} (${c.year}) ${bggGameUrl(c.id)}`).join(" ; ")}
Do not present any of these as the user's game unless it is clearly the one they mean; if unsure, ask which they mean. There is no verified link for "${asked}". BGG search link: ${search}`;
  }
  return `=== BOARDGAMEGEEK: "${asked}" was not found in BGG's list of ~7,000 well-rated games ===
No verified link, year or rating is available. Do not invent a BGG URL, ID, year or rating. If asked for a link, give this search link: ${search}`;
}

// Used only when no BGG index has been published: model-remembered facts, clearly flagged, and a search link
// (never a model-remembered game id, which is often wrong).
export function legacyBggBlock(d, asked) {
  const facts = [
    d.minPlayers && d.maxPlayers && `Players: ${d.minPlayers}–${d.maxPlayers}`,
    d.minPlaytime && `Playtime: ${d.minPlaytime} min`,
    d.rating && `BGG rating: ${d.rating}/10`,
    d.weight && `Complexity: ${d.weight}/5`,
    d.year && `Year: ${d.year}`,
  ].filter(Boolean);
  const lines = [`=== BOARDGAMEGEEK (unverified, from model memory) FOR "${asked}" ===`];
  if(facts.length) lines.push(facts.join(" | "));
  if(d.description) lines.push(`Description: ${d.description}`);
  lines.push(`BGG search link (the only BGG link to give): ${bggSearchUrl(asked)}`);
  return lines.join("\n");
}

// Chat text with BoardGameGeek URLs made clickable. Other URLs stay plain text, so a reply can't smuggle in an
// arbitrary link; trailing punctuation ("…/13).") is left outside the link.
const BGG_URL_RE = /(https?:\/\/(?:www\.)?boardgamegeek\.com\/[^\s<>"']*[^\s<>"'.,;:!?)\]])/g;
export function BggLinkText({text}){
  return String(text ?? "").split(BGG_URL_RE).map((part, i) =>
    i % 2
      ? <a key={i} href={part} target="_blank" rel="noreferrer noopener" style={{color:T.steam,textDecoration:"underline"}}>{part}</a>
      : part
  );
}

export function CrewAssistant({ctx}){
  const {profile, authUser, users, games, food, supplies, voyageMenu, deckHands, receipts, itinerary} = ctx;

  const firstName = profile?.name?.split(" ")[0] || "Crew";
  const myRoleKey = users?.[authUser?.uid]?.narrativeRole || profile?.narrativeRole;
  const welcomeMsg = () => ({role:"model", text:`🏴‍☠️ Ahoy, ${firstName}! Sky-pirate automaton at your service. Ask me about games, food, duties, the schedule, or how to use the app.`});

  const [open,       setOpen]      = useState(false);
  const [messages,   setMessages]  = useState([welcomeMsg()]);
  const [input,      setInput]     = useState("");
  const [loading,    setLoading]   = useState(false);
  const bottomRef = useRef(null);
  const inputRef  = useRef(null);

  // ── Per-user suggestions ────────────────────────────────────────────────────
  // Derive what the current user hasn't done yet
  const userSuggestions = React.useMemo(()=>{
    if(!authUser?.uid) return [];
    const uid = authUser.uid;
    const tips = [];

    // Check duties
    const hasDuty = Object.values(deckHands||{}).some(s=>s.claimedBy===uid);
    if(!hasDuty) tips.push({
      text:"Sign me up for a duty 🧹",
      label:"No duties signed up yet",
    });

    // Check food / provisions
    const hasFood = Object.values(food||{}).some(f=>f.ownerId===uid);
    const hasSupply = Object.values(supplies||{}).some(s=>s.ownerId===uid);
    if(!hasFood && !hasSupply) tips.push({
      text:"What food should I bring? 🍲",
      label:"Nothing added to Galley yet",
    });

    // Check games
    const hasGame = Object.values(games||{}).some(g=>g.ownerId===uid && !g.isRequest);
    if(!hasGame) tips.push({
      text:"How do I add a game to the Cargo Hold? 🎲",
      label:"No games added yet",
    });

    return tips;
  },[authUser?.uid, deckHands, food, supplies, games]);

  // Update welcome message when profile loads (name may not be available on first render)
  useEffect(()=>{
    setMessages(m=>{
      if(m.length===1 && m[0].role==="model") return [welcomeMsg()];
      return m;
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  },[profile?.name]);

  // Auto-popup after 30 seconds — only once per session
  useEffect(()=>{
    const t = setTimeout(()=>setOpen(true), 30000);
    return ()=>clearTimeout(t);
  },[]);

  // Auto-scroll to latest message
  useEffect(()=>{ bottomRef.current?.scrollIntoView({behavior:"smooth"}); },[messages]);

  // Focus input when opened
  useEffect(()=>{ if(open) setTimeout(()=>inputRef.current?.focus(), 100); },[open]);


  // buildAllContext — all Firestore collections in one structured snapshot
  const buildAllContext = (matcher, closingTip) => {
    const uList  = Object.values(users      ||{});
    const gList  = Object.values(games      ||{}).filter(g=>!g.isRequest);
    const gReqs  = Object.values(games      ||{}).filter(g=>g.isRequest);
    const fList  = Object.values(food       ||{});
    const sList  = Object.values(supplies   ||{});
    const dhList = Object.values(deckHands  ||{});
    const vmList = Object.values(voyageMenu ||{});
    const rcList = Object.values(receipts   ||{});
    const days   = Object.values(itinerary  ||{}).sort((a,b)=>(a.date||"").localeCompare(b.date||""));
    const sections = [];

    sections.push("=== CREW ===");
    if(uList.length) uList.forEach(u=>{
      const p=[`${u.name} (${u.crewRank||"Enlisted"})`];
      if(u.dietary?.length) p.push(`dietary: ${u.dietary.join(", ")}`);
      if(u.deposit) p.push("deposit: paid");
      sections.push(p.join(" | "));
    }); else sections.push("No crew yet.");

    sections.push("=== GAMES IN CARGO HOLD (ONLY source for game questions — never invent games) ===");
    if(gList.length) gList.forEach(g=>{
      const p=[g.name];
      if(g.category)      p.push(g.category);
      if(g.minPlayers)    p.push(`${g.minPlayers}${g.maxPlayers&&g.maxPlayers!==g.minPlayers?"-"+g.maxPlayers:""} players`);
      if(g.likes?.length) p.push(`${g.likes.length} votes`);
      const bgg = matcher?.exact(g.name);
      if(bgg) p.push(`${bgg.year}`, `BGG rating ${bgg.rating}/10`, `BGG link: ${bggGameUrl(bgg.id)}`);
      p.push(`brought by ${users[g.ownerId]?.name||"crew"}`);
      sections.push(p.join(" | "));
    }); else sections.push("Cargo Hold is empty — no games loaded.");
    if(gReqs.length){ sections.push("Requested games (not physically here):"); gReqs.forEach(g=>sections.push(`  ${g.name}`)); }

    sections.push("=== ITINERARY ===");
    if(days.length) days.forEach(d=>{
      const acts=d.activities?.length?` | ${d.activities.join(", ")}` :"";
      sections.push(`${d.date}: ${d.label||""}${acts}${d.notes?" | Note: "+d.notes:""}`);
    }); else sections.push("No itinerary set.");

    sections.push("=== GALLEY — FOOD BEING BROUGHT (Provisions) ===");
    if(fList.length) fList.forEach(f=>{
      sections.push(`${f.name}${f.category?" ("+f.category+")":""}${f.serves?" serves "+f.serves:""} — ${users[f.ownerId]?.name||"crew"}`);
    }); else sections.push("No food logged yet.");

    sections.push("=== GALLEY — GEAR & SUPPLIES ===");
    if(sList.length) sList.forEach(s=>{
      sections.push(`${s.name}${s.category?" ("+s.category+")":""} — ${users[s.ownerId]?.name||"crew"}`);
    }); else sections.push("No gear logged yet.");

    if(vmList.length){
      sections.push("=== MEAL PLAN ===");
      vmList.forEach(m=>sections.push(`${m.day} ${m.meal}: ${m.dish||"TBD"}${m.notes?" ("+m.notes+")":""}`));
    }

    sections.push("=== DUTY ASSIGNMENTS ===");
    const claimed=dhList.filter(s=>s.claimedBy);
    if(claimed.length) claimed.forEach(s=>{
      sections.push(`${s.day} | ${s.type==="prep"?"Prep":"Cleanup"}: ${s.task} — ${users[s.claimedBy]?.name||"crew"}`);
    }); else sections.push("No duties claimed yet.");
    const open=dhList.filter(s=>!s.claimedBy);
    if(open.length){ sections.push("Open slots:"); open.forEach(s=>sections.push(`  ${s.day} | ${s.type==="prep"?"Prep":"Cleanup"}: ${s.task}`)); }

    if(rcList.length){
      const total=sumAmount(rcList);
      sections.push(`=== EXPENSES (total $${total.toFixed(2)}) ===`);
      rcList.forEach(r=>sections.push(`$${r.amount} — ${r.description||"expense"} (${users[r.ownerId]?.name||"crew"})`));
    }

    sections.push(`=== CURRENT USER: ${profile?.name||"Crew"} (${profile?.crewRank||"Enlisted"}) ===`);

    sections.push("=== CLOSING TIP (end any game-related answer with exactly this line) ===");
    sections.push(closingTip || `Tip: ${HUSS_TIP}`);

    // App how-to instructions — guides users on how to use each section
    sections.push("=== APP INSTRUCTIONS (answer how-to questions from this section only) ===");
    sections.push("ADD A GAME: Cargo Hold tab -> tap Load Cargo -> fill in name, category, player count -> Save. BGG URL auto-fills.");
    sections.push("REQUEST A GAME: Cargo Hold -> tap Request Game -> enter game name and note -> Save. Appears as a request until someone brings it.");
    sections.push("VOTE FOR A GAME: Cargo Hold -> tap the heart icon on any game card. Cannot vote for your own games.");
    sections.push("EDIT / DELETE A GAME: Cargo Hold -> tap the pencil (edit) or trash (delete) icon on your own game cards only.");
    sections.push("ADD FOOD: Galley tab -> Food sub-tab -> tap Add Item -> enter name, category, how many it serves -> Save.");
    sections.push("ADD GEAR / SUPPLIES: Galley tab -> Gear sub-tab -> tap Add Item -> enter name and category -> Save.");
    sections.push("PLAN A MEAL: Galley tab -> Voyage Menu sub-tab -> pick a day and meal slot -> tap Add -> enter dish name -> Save.");
    sections.push("SIGN UP FOR DUTIES: Deck Hands tab -> select a day at the top -> tap an open Prep or Cleanup slot to claim it. Tap again to unclaim.");
    sections.push("UPDATE YOUR PROFILE: Personal Log tab (avatar in top-right) -> edit name, photo, rank, dietary restrictions -> tap Update Ship's Log.");
    sections.push("LOG A RECEIPT: Manifest tab -> optionally fill description and amount -> tap Choose Image -> AI scans the receipt and fills the amount automatically.");
    sections.push("ENABLE NOTIFICATIONS: Personal Log tab -> tap Enable on the notification banner -> allow when the browser asks.");
    sections.push("VIEW SCHEDULE / MAP: Itinerary tab shows the full weekend plan, Google Maps, and activities for each day.");
    sections.push("ENGINE ROOM (admin only): Password is cottage con. Has: Itinerary editor, Deck Hand slot editor, Deposit tracker, Crew Rank manager, and Notify panel for push notifications.");
    sections.push("INSTALL APP on iPhone: Open in Safari -> tap Share button -> Add to Home Screen.");
    sections.push("INSTALL APP on Android: Tap three-dot menu in Chrome -> Install App or Add to Home Screen.");
    sections.push("AI GAME RECOMMENDER: Cargo Hold tab -> tap Recommend button -> set player count, mood, duration -> tap What Should We Play.");
    sections.push("THIS CHAT ASSISTANT: Tap the pirate flag button in the bottom-right corner of any page. Ask anything about games, food, schedule, duties, or how to use the app.");

    return sections.join("\n");
  };

  const send = async (override) => {
    const text = (typeof override==="string" ? override : input).trim();
    if(!text || loading) return;
    setInput("");

    const userMsg = {role:"user", text};
    setMessages(m=>[...m, userMsg]);
    setLoading(true);

    // Build clean history — skip welcome, strip any old [Firestore data] prefixes
    const history = messages
      .filter((_,i)=>i>0)
      .map(m=>({
        role: m.role,
        parts:[{text: m.role==="user" ? m.text.replace(/^\[Current Firestore data:[\s\S]*?\]\n\nUser question: /,"") : m.text}]
      }));

    // Detect topic and inject only the relevant Firestore sections

    // BoardGameGeek index (null when none is published) — source of verified links/facts instead of model memory
    const matcher = await getBggMatcher();

    // Always inject fresh Firestore snapshot
    const ctx_snapshot = buildAllContext(matcher, pickChatTip(myRoleKey));

    // BGG lookup — if question mentions a specific game name, fetch BGG data
    let bggContext = "";
    const gAllList = Object.values(games||{});

    // Detect any game-related question — rules, details, info, or game name mentioned
    const isGameQ = /\b(rules?|how.?to.?play|how.?do.?you.?play|explain|setup|set.?up|teach|mechanic|detail|info|tell me about|what is|weight|rating|how many player|how long|duration|category|expansion|similar|like|compare|strategy|tip|trick|beginner|advanced|overview|summary|description|links?|url|bgg|boardgamegeek|published|year|rated)\b/i.test(text);

    // Extract game name even if not in Cargo Hold
    const extractedName = (() => {
      // Match after game-context keywords
      const m = text.match(/(?:rules?(?:\s+for)?|how(?:\s+to)?(?:\s+play)?|explain|teach|about|play|details?(?:\s+for)?|info(?:rmation)?(?:\s+on)?)\s+([A-Z][\w\s\-:]{1,30}?)(?:\?|$|\.|,|\bplease\b)/i);
      if(m?.[1]) return m[1].trim();
      // Match quoted game name
      const q = text.match(/["']([^"']{2,30})["']/);
      if(q?.[1]) return q[1].trim();
      return null;
    })();

    // Which games is the question about? Up to 3, from: (a) Cargo Hold games named in it — whole-word match, so a
    // short name like "Go" doesn't fire inside "going"; (b) any BGG-indexed title in the text; (c) a name pulled
    // out of "rules for X"-style phrasing (covers games outside the index).
    const normText  = ` ${normalizeName(text)} `;
    const looksGamey = isGameQ || /\b(games?|play(?:ing)?)\b/i.test(text);
    const targets   = [];
    const addTarget = (name) => {
      if(name && targets.length < 3 && !targets.some(t => normalizeName(t) === normalizeName(name))) targets.push(name);
    };
    gAllList.filter(g => g.name && normText.includes(` ${normalizeName(g.name)} `)).forEach(g => addTarget(g.name));
    if(matcher && looksGamey) matcher.findInText(text).forEach(g => addTarget(g.name));
    if(!targets.length && isGameQ && extractedName) addTarget(cleanAskedTitle(extractedName));

    if(targets.length){
      console.log("[BGG] Triggered by game question, looking up:", targets.join(" | "));
      if(matcher){
        // Verified facts + real links straight from the index — no extra model call
        bggContext = "\n\n" + targets.map(t => bggFactsBlock(matcher.find(t), t)).join("\n\n");
      } else {
        // No index published: fall back to the model's recollection, but only ever hand out a search link
        const bggData = await lookupBGG(targets[0]);
        if(bggData) bggContext = "\n\n" + legacyBggBlock(bggData, targets[0]);
        else console.log("[BGG] No data found for:", targets[0]);
      }
    }

    console.log("[Assistant context sent — lines:", ctx_snapshot.split("\n").length, bggContext ? "| BGG data included" : "");
    const contextPrefix = `[Current Firestore data:\n${ctx_snapshot}${bggContext}]\n\nUser question: `;
    try {
      const reply = await askGemini(contextPrefix + text, history);
      setMessages(m=>[...m, {role:"model", text:reply}]);
    } catch(e) {
      setMessages(m=>[...m, {role:"model", text:`⚠️ ${e.message||"Something went wrong. Try again."}`, error:true}]);
    }
    setLoading(false);
  };

  const clear = () => setMessages([welcomeMsg()]);

  // Quick suggestion chips
  const CHIPS = [
    "What should we play tonight?",
    "Explain the rules of a quick game",
    "What's for dinner tonight?",
    "What's the checkout time?",
    "Suggest a party game for 6 people",
  ];

  return (
    <>
      {/* Floating button */}
      <button
        onClick={()=>setOpen(o=>!o)}
        aria-label="Open crew assistant"
        style={{
          position:"fixed",
          bottom:`max(24px, calc(env(safe-area-inset-bottom) + 16px))`,
          right:20, zIndex:8000,
          width:52, height:52,
          borderRadius:"50%",
          background:open ? T.surface2 : T.amber,
          border:`2px solid ${open?T.border2:T.amber}`,
          cursor:"pointer",
          display:"flex", alignItems:"center", justifyContent:"center",
          fontSize:24, lineHeight:1,
          boxShadow:`0 4px 20px rgba(0,0,0,.5), 0 0 0 3px ${T.amber}33`,
          transition:"all .2s",
          color: open ? T.muted : T.bg,
        }}>
        {open ? "✕" : "🏴‍☠️"}
      </button>

      {/* Chat panel */}
      {open&&<div style={{
        position:"fixed",
        bottom:`max(88px, calc(env(safe-area-inset-bottom) + 80px))`,
        right:16, zIndex:7999,
        width:"min(420px, calc(100vw - 32px))",
        height:"min(560px, calc(100dvh - 160px))",
        background:T.bgMid,
        border:`2px solid ${T.border2}`,
        borderRadius:12,
        display:"flex", flexDirection:"column",
        boxShadow:`0 8px 48px rgba(0,0,0,.7), 0 0 0 1px ${T.amber}22`,
        overflow:"hidden",
        animation:"ccFade .2s ease",
      }}>

        {/* Header */}
        <div style={{
          background:T.surface, borderBottom:`1px solid ${T.border2}`,
          padding:"12px 16px", display:"flex", alignItems:"center", gap:10, flexShrink:0,
        }}>
          <span style={{fontSize:22}}>🏴‍☠️</span>
          <div style={{flex:1}}>
            <div style={{fontFamily:"'Cinzel',serif",fontSize:13,fontWeight:700,color:T.amber,letterSpacing:".04em"}}>Crew Assistant</div>
            <div style={{fontSize:10,color:T.hint}}>Powered by Gemini · Cottage Con 2026</div>
          </div>
          <button onClick={clear} title="Clear chat"
            style={{background:"none",border:`1px solid ${T.border}`,cursor:"pointer",color:T.hint,fontSize:12,fontFamily:"'Cinzel',serif",padding:"3px 8px",borderRadius:4}}>
            Clear
          </button>
        </div>

        {/* Messages */}
        <div style={{flex:1,overflowY:"auto",padding:"14px 14px 8px",display:"flex",flexDirection:"column",gap:10}}>
          {messages.map((m,i)=>(
            <div key={i} style={{
              display:"flex",
              justifyContent:m.role==="user"?"flex-end":"flex-start",
              gap:8, alignItems:"flex-end",
            }}>
              {m.role==="model"&&<div style={{
                width:28,height:28,borderRadius:"50%",background:T.surface,
                border:`1px solid ${T.border2}`,display:"flex",alignItems:"center",
                justifyContent:"center",fontSize:14,flexShrink:0,alignSelf:"flex-end",
              }}>⚙️</div>}
              <div style={{
                maxWidth:"78%",
                padding:"9px 13px",
                borderRadius:m.role==="user"?"12px 12px 4px 12px":"12px 12px 12px 4px",
                background:m.role==="user"?T.amber:T.surface,
                color:m.role==="user"?T.bg:m.error?T.danger:T.text,
                fontSize:13, lineHeight:1.65,
                border:m.role==="model"?`1px solid ${T.border}`:"none",
                whiteSpace:"pre-wrap", wordBreak:"break-word",
              }}>
                {m.role==="model" ? <BggLinkText text={m.text}/> : m.text}
              </div>
              {m.role==="user"&&<Avatar name={profile?.name} picture={profile?.picture} size={28}/>}
            </div>
          ))}

          {/* Typing indicator */}
          {loading&&<div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
            <div style={{width:28,height:28,borderRadius:"50%",background:T.surface,border:`1px solid ${T.border2}`,display:"flex",alignItems:"center",justifyContent:"center",fontSize:14}}>🏴‍☠️</div>
            <div style={{padding:"10px 14px",borderRadius:"12px 12px 12px 4px",background:T.surface,border:`1px solid ${T.border}`}}>
              <div style={{display:"flex",gap:4,alignItems:"center"}}>
                {[0,1,2].map(i=>(
                  <div key={i} style={{width:6,height:6,borderRadius:"50%",background:T.amber,
                    animation:`ccSpin .9s ease-in-out ${i*0.2}s infinite`,
                    animationName:"pulse"}}/>
                ))}
              </div>
            </div>
          </div>}

          {/* Quick chips — show only on welcome message */}
          {messages.length===1&&!loading&&(
            <div style={{display:"flex",flexDirection:"column",gap:8,marginTop:4}}>
              {/* Personalised action suggestions */}
              {userSuggestions.length>0&&(
                <div>
                  <div style={{fontSize:10,color:T.amber,fontFamily:"'Cinzel',serif",
                    letterSpacing:".06em",textTransform:"uppercase",marginBottom:5}}>
                    ⚡ Suggested for you
                  </div>
                  <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                    {userSuggestions.map(s=>(
                      <button key={s.text} onClick={()=>send(s.text)}
                        style={{fontFamily:"inherit",fontSize:11,padding:"5px 10px",borderRadius:16,
                          border:`1.5px solid ${T.amber}66`,background:T.amberSoft,color:T.amber,
                          cursor:"pointer",transition:"all .15s",textAlign:"left",lineHeight:1.3,
                          display:"flex",flexDirection:"column",gap:1}}>
                        <span>{s.text}</span>
                        <span style={{fontSize:9,opacity:.7}}>{s.label}</span>
                      </button>
                    ))}
                  </div>
                </div>
              )}
              {/* General quick chips */}
              <div>
                {userSuggestions.length>0&&<div style={{fontSize:10,color:T.hint,fontFamily:"'Cinzel',serif",
                  letterSpacing:".06em",textTransform:"uppercase",marginBottom:5}}>
                  Or ask anything
                </div>}
                <div style={{display:"flex",flexWrap:"wrap",gap:5}}>
                  {CHIPS.map(chip=>(
                    <button key={chip} onClick={()=>send(chip)}
                      style={{fontFamily:"inherit",fontSize:11,padding:"5px 10px",borderRadius:16,
                        border:`1.5px solid ${T.border2}`,background:T.surface,color:T.muted,
                        cursor:"pointer",transition:"all .15s",textAlign:"left",lineHeight:1.3}}
                      onMouseEnter={e=>{e.currentTarget.style.borderColor=T.amber;e.currentTarget.style.color=T.amber;}}
                      onMouseLeave={e=>{e.currentTarget.style.borderColor=T.border2;e.currentTarget.style.color=T.muted;}}>
                      {chip}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          <div ref={bottomRef}/>
        </div>

        {/* Input */}
        <div style={{
          borderTop:`1px solid ${T.border}`,padding:"10px 12px",
          display:"flex",gap:8,alignItems:"flex-end",flexShrink:0,
          background:T.surface,
        }}>
          <textarea
            ref={inputRef}
            value={input}
            onChange={e=>setInput(e.target.value)}
            onKeyDown={e=>{ if(e.key==="Enter"&&!e.shiftKey){ e.preventDefault(); send(); } }}
            placeholder="Ask anything about the cottage weekend…"
            rows={1}
            style={{
              flex:1, fontFamily:"inherit", fontSize:13,
              padding:"8px 12px", borderRadius:8,
              border:`2px solid ${T.border2}`,background:T.bgMid,color:T.text,
              outline:"none", resize:"none", lineHeight:1.5,
              maxHeight:100, overflowY:"auto",
            }}
          />
          <button onClick={send} disabled={!input.trim()||loading}
            style={{
              width:38,height:38,borderRadius:8,border:"none",cursor:"pointer",
              background:input.trim()&&!loading?T.amber:T.border,
              color:input.trim()&&!loading?T.bg:T.hint,
              display:"flex",alignItems:"center",justifyContent:"center",
              fontSize:16,flexShrink:0,transition:"all .15s",
            }}>
            ➤
          </button>
        </div>
      </div>}
    </>
  );
}

// ── CostCalculator sub-components (outside parent to preserve input focus) ────
function CCLineItem({label, amount, sub, bold=false}){
  return(
    <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",
      padding:"10px 0",borderBottom:`1px solid ${T.border}`}}>
      <div>
        <div style={{fontSize:13,color:bold?T.amber:T.text,fontWeight:bold?700:400,
          fontFamily:bold?"'Cinzel',serif":"inherit"}}>{label}</div>
        {sub&&<div style={{fontSize:11,color:T.hint,marginTop:2}}>{sub}</div>}
      </div>
      <div style={{fontFamily:"'Cinzel',serif",fontSize:14,fontWeight:bold?700:500,
        color:bold?T.amber:T.text,flexShrink:0,marginLeft:16}}>
        ${typeof amount==="number"?amount.toFixed(2):amount}
      </div>
    </div>
  );
}

function CCNumInput({label, value, onChange, placeholder="0.00", style={}}){
  return(
    <div style={style}>
      {label&&<span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",
        letterSpacing:".06em",display:"block",marginBottom:6}}>{label}</span>}
      <div style={{position:"relative"}}>
        <span style={{position:"absolute",left:10,top:"50%",transform:"translateY(-50%)",
          color:T.muted,fontSize:14,pointerEvents:"none"}}>$</span>
        <input type="number" min="0" step="0.01" value={value} onChange={e=>onChange(e.target.value)}
          placeholder={placeholder}
          style={{width:"100%",fontFamily:"inherit",fontSize:14,padding:"9px 12px 9px 24px",
            borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,
            color:T.text,outline:"none",boxSizing:"border-box"}}/>
      </div>
    </div>
  );
}

function CCTextInput({label, value, onChange, style={}}){
  return(
    <div style={style}>
      {label&&<span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",
        letterSpacing:".06em",display:"block",marginBottom:6}}>{label}</span>}
      <input value={value} onChange={e=>onChange(e.target.value)}
        style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"9px 12px",
          borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,
          color:T.text,outline:"none",boxSizing:"border-box"}}/>
    </div>
  );
}

// Extra cost line item (label + amount) — module-level to avoid focus loss
function CCExtraItem({label, amount, onChange, onRemove}){
  return(
    <div style={{display:"flex",gap:6,alignItems:"flex-end",marginTop:8}}>
      <CCTextInput label="Label" value={label} onChange={v=>onChange({label:v,amount})} style={{flex:2}}/>
      <CCNumInput  label="Amount" value={amount} onChange={v=>onChange({label,amount:v})} style={{flex:1}}/>
      <button onClick={onRemove}
        style={{width:32,height:36,borderRadius:5,border:`1.5px solid ${T.border2}`,
          background:T.surface2,color:T.danger,cursor:"pointer",
          fontSize:16,lineHeight:1,flexShrink:0,marginBottom:0}}>×</button>
    </div>
  );
}

// Module-level so it doesn't remount on every CostCalculator re-render (avoids focus loss)
function CCPaymentEntry({desc, amount, onChange, onRemove}){
  return(
    <div style={{display:"flex",gap:6,alignItems:"center",marginTop:6}}>
      <input value={desc} onChange={e=>onChange({desc:e.target.value,amount})}
        placeholder="Description (e.g. Cottage deposit)"
        style={{flex:2,fontFamily:"inherit",fontSize:12,padding:"7px 10px",
          borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,
          color:T.text,outline:"none",minWidth:0}}/>
      <input value={amount} onChange={e=>onChange({desc,amount:e.target.value})}
        placeholder="0.00" type="number" min="0" step="0.01"
        style={{flex:1,fontFamily:"inherit",fontSize:12,padding:"7px 10px",
          borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,
          color:T.amber,outline:"none",minWidth:0,textAlign:"right"}}/>
      <button onClick={onRemove}
        style={{width:28,height:28,borderRadius:5,border:`1.5px solid ${T.border2}`,
          background:T.surface2,color:T.danger,cursor:"pointer",
          fontSize:14,lineHeight:1,flexShrink:0}}>×</button>
    </div>
  );
}

// ── Cost Calculator (Engine Room) ─────────────────────────────────────────────
function CostCalculator({ctx}){
  const {receipts, users, costSettings, doSaveCostSettings, showToast} = ctx;

  const receiptList  = Object.values(receipts||{});
  const manifestTotal = sumAmount(receiptList);
  const uList        = Object.values(users||{});
  const depositAmt   = 50; // $50 deposit deduction per paid crew member

  // Load from Firestore costSettings, fall back to defaults
  const [rentalCost,  setRentalCost]  = useState(costSettings?.rental  || "");
  const [swagCost,    setSwagCost]    = useState(costSettings?.swag     || "");
  // Multi-item extra costs: [{label, amount}]
  const [extraItems,  setExtraItems]  = useState(
    costSettings?.extraItems || (costSettings?.extraLbl ? [{label:costSettings.extraLbl, amount:costSettings.extra||""}] : [])
  );
  const [splitMode,   setSplitMode]   = useState(costSettings?.splitMode|| "all");
  const [customCount, setCustomCount] = useState(costSettings?.custom   || "");
  // Per-user guest multipliers: {userId: extraGuests}
  const [guestMap,    setGuestMap]    = useState(costSettings?.guestMap    || {});
  // Per-user payments: {userId: [{desc:string, amount:string}]}
  const [paymentsMap, setPaymentsMap] = useState(costSettings?.paymentsMap || {});
  const [saving,      setSaving]      = useState(false);
  const [dirty,       setDirty]       = useState(false);

  const markDirty = fn => (...args) => { fn(...args); setDirty(true); };

  const save = async () => {
    setSaving(true);
    await doSaveCostSettings({rental:rentalCost,swag:swagCost,
      extraItems,splitMode,custom:customCount,guestMap,paymentsMap});
    setSaving(false); setDirty(false);
    showToast("Cost settings saved! 💰");
  };

  // Guest multiplier — must be defined before any calculations that use it
  const getMultiplier = uid => 1 + (parseInt(guestMap[uid])||0);

  // Payments helpers
  const receiptsByUser = uid => receiptList.filter(r=>r.ownerId===uid);
  const receiptTotalByUser = uid => sumAmount(receiptsByUser(uid));
  const manualPaidByUser = uid => sumAmount(paymentsMap[uid]||[]);
  const paidByUser = uid => manualPaidByUser(uid) + receiptTotalByUser(uid);
  const totalCrewPayments = uList.reduce((s,u)=>s+paidByUser(u.id),0);

  const addPayment = uid => {
    setPaymentsMap(m=>({...m,[uid]:[...(m[uid]||[]),{desc:"",amount:""}]}));
    setDirty(true);
  };
  const updatePayment = (uid, idx, val) => {
    setPaymentsMap(m=>{
      const arr=[...(m[uid]||[])];
      arr[idx]={...arr[idx],...val};
      return {...m,[uid]:arr};
    });
    setDirty(true);
  };
  const removePayment = (uid, idx) => {
    setPaymentsMap(m=>{
      const arr=(m[uid]||[]).filter((_,i)=>i!==idx);
      return {...m,[uid]:arr};
    });
    setDirty(true);
  };

  // Calculations
  const rental     = parseFloat(rentalCost) || 0;
  const swag       = parseFloat(swagCost)   || 0;
  const extraTotal = sumAmount(extraItems);
  const grossTotal = rental + swag + extraTotal + manifestTotal;

  // Effective headcount including guests
  const totalHeads = uList.reduce((s,u)=>s+getMultiplier(u.id),0);

  // Deposits: $50 per crew member who has paid (multiplied by guest count)
  const paidCount    = uList.filter(u=>u.deposit).length;
  const depositTotal = uList
    .filter(u=>u.deposit)
    .reduce((s,u)=>s + getMultiplier(u.id) * depositAmt, 0);
  const netTotal     = Math.max(0, grossTotal - depositTotal);

  const splitCount = splitMode==="all"    ? totalHeads
                   : splitMode==="adults" ? uList.filter(u=>(u.crewRank||"Enlisted")==="Officer").reduce((s,u)=>s+getMultiplier(u.id),0)
                   : parseInt(customCount)||1;

  const perHead = splitCount > 0 ? netTotal / splitCount : 0;

  const setGuest = (uid, val) => {
    setGuestMap(m=>({...m,[uid]:val}));
    setDirty(true);
  };

  const addExtraItem = () => {
    setExtraItems(a=>[...a,{label:"",amount:""}]);
    setDirty(true);
  };
  const updateExtraItem = (idx, val) => {
    setExtraItems(a=>{const n=[...a];n[idx]={...n[idx],...val};return n;});
    setDirty(true);
  };
  const removeExtraItem = idx => {
    setExtraItems(a=>a.filter((_,i)=>i!==idx));
    setDirty(true);
  };

  return(
    <div>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:20,flexWrap:"wrap",gap:8}}>
        <h3 style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber}}>🧮 Cost Calculator</h3>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <span style={{fontSize:11,color:T.hint,fontFamily:"'Cinzel',serif"}}>
            {uList.length} crew · {paidCount} deposits · {totalHeads} total heads
          </span>
          {dirty&&<Btn size="sm" onClick={save} disabled={saving}>
            {saving?"Saving…":"💾 Save"}
          </Btn>}
        </div>
      </div>

      {/* ── Cost Inputs ── */}
      <Card style={{background:T.bgMid,marginBottom:16}}>
        <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,marginBottom:14,letterSpacing:".04em"}}>
          ⚙️ Cost Inputs
        </h4>
        {/* Fixed entries */}
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(170px,1fr))",gap:14,marginBottom:14}}>
          <CCNumInput label="Cottage Rental" value={rentalCost} onChange={markDirty(setRentalCost)}/>
          <CCNumInput label="Swag / Prizes"  value={swagCost}   onChange={markDirty(setSwagCost)}/>
        </div>
        {/* Dynamic extra items */}
        {extraItems.length>0&&(
          <div style={{borderTop:`1px solid ${T.border}`,paddingTop:12,marginBottom:12}}>
            <span style={{fontSize:11,fontWeight:600,color:T.muted,textTransform:"uppercase",
              letterSpacing:".06em"}}>Additional Items</span>
            {extraItems.map((item,i)=>(
              <CCExtraItem key={i} label={item.label} amount={item.amount}
                onChange={val=>updateExtraItem(i,val)}
                onRemove={()=>removeExtraItem(i)}/>
            ))}
          </div>
        )}
        <button onClick={addExtraItem}
          style={{fontSize:11,padding:"5px 12px",borderRadius:5,border:`1.5px dashed ${T.border2}`,
            background:"transparent",color:T.muted,cursor:"pointer",fontFamily:"'Cinzel',serif",
            letterSpacing:".04em",width:"100%",marginBottom:14}}>
          + Add Cost Item
        </button>
        {/* Manifest auto-total */}
        <div style={{padding:"10px 14px",borderRadius:7,background:T.surface,border:`1px solid ${T.border}`}}>
          <div style={{display:"flex",alignItems:"center",justifyContent:"space-between"}}>
            <div>
              <span style={{fontSize:12,color:T.muted}}>Manifest receipts</span>
              <span style={{fontSize:11,color:T.hint,display:"block",marginTop:2}}>Auto-pulled from Firestore · {receiptList.length} receipt{receiptList.length!==1?"s":""}</span>
            </div>
            <span style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.amber,fontWeight:700}}>${manifestTotal.toFixed(2)}</span>
          </div>
        </div>
      </Card>

      {/* ── Breakdown ── */}
      <Card style={{background:T.bgMid,marginBottom:16}}>
        <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,marginBottom:4,letterSpacing:".04em"}}>📋 Cost Breakdown</h4>
        {grossTotal===0
          ? <p style={{fontSize:13,color:T.hint,fontStyle:"italic",padding:"12px 0",textAlign:"center"}}>Enter costs above to see the breakdown.</p>
          : <>
            {rental>0       && <CCLineItem label="Cottage Rental"  amount={rental}/>}
            {swag>0         && <CCLineItem label="Swag / Prizes"   amount={swag}/>}
            {extraItems.filter(i=>parseFloat(i.amount)>0).map((item,i)=>(
              <CCLineItem key={i} label={item.label||"Other"} amount={parseFloat(item.amount)}/>
            ))}
            {manifestTotal>0&& <CCLineItem label="Manifest Receipts" amount={manifestTotal} sub={`${receiptList.length} receipt${receiptList.length!==1?"s":""}`}/>}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${T.border}`}}>
              <div style={{fontSize:13,color:T.text}}>Gross Total</div>
              <div style={{fontFamily:"'Cinzel',serif",fontSize:14,color:T.text}}>${grossTotal.toFixed(2)}</div>
            </div>
            {paidCount>0 && <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${T.border}`}}>
              <div>
                <div style={{fontSize:13,color:"#4ADE80"}}>💰 Deposit deductions</div>
                <div style={{fontSize:11,color:T.hint,marginTop:2}}>{paidCount} paid × ${depositAmt} each</div>
              </div>
              <div style={{fontFamily:"'Cinzel',serif",fontSize:14,color:"#4ADE80"}}>−${depositTotal.toFixed(2)}</div>
            </div>}
            {totalCrewPayments>0 && <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",padding:"10px 0",borderBottom:`1px solid ${T.border}`}}>
              <div>
                <div style={{fontSize:13,color:"#60A5FA"}}>💳 Crew payments recorded</div>
                <div style={{fontSize:11,color:T.hint,marginTop:2}}>Applied to individual balances below</div>
              </div>
              <div style={{fontFamily:"'Cinzel',serif",fontSize:14,color:"#60A5FA"}}>${totalCrewPayments.toFixed(2)}</div>
            </div>}
            <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",paddingTop:12,marginTop:4}}>
              <span style={{fontFamily:"'Cinzel',serif",fontSize:13,color:T.amber,fontWeight:700,letterSpacing:".04em"}}>NET TOTAL</span>
              <span style={{fontFamily:"'Cinzel',serif",fontSize:22,fontWeight:700,color:T.amber,textShadow:`0 0 12px ${T.amber}66`}}>${netTotal.toFixed(2)}</span>
            </div>
          </>}
      </Card>

      {/* ── Guest multipliers ── */}
      <Card style={{background:T.bgMid,marginBottom:16}}>
        <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,marginBottom:4,letterSpacing:".04em"}}>👥 Extra Guests per Crew</h4>
        <p style={{fontSize:12,color:T.hint,marginBottom:14}}>If crew are bringing people who haven't registered, add their count here. They'll be included in the per-person split.</p>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {uList.map(u=>{
            const rank=CREW_RANKS[u.crewRank||"Enlisted"]||CREW_RANKS["Enlisted"];
            const extra=parseInt(guestMap[u.id])||0;
            return(
              <div key={u.id} style={{display:"flex",alignItems:"center",gap:10,padding:"8px 12px",
                background:T.surface,borderRadius:7,border:`1px solid ${T.border}`}}>
                <Avatar name={u.name} picture={u.picture} size={34}/>
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:5}}>
                    <span style={{fontSize:13,color:T.text,fontWeight:500}}>{u.name}</span>
                    <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:rank.bg,
                      color:rank.text,border:`1px solid ${rank.border}`,fontFamily:"'Cinzel',serif",fontWeight:700}}>{rank.icon}</span>
                  </div>
                  <span style={{fontSize:11,color:T.hint}}>{1+extra} person{1+extra!==1?"s":""} total</span>
                </div>
                <div style={{display:"flex",alignItems:"center",gap:6,flexShrink:0}}>
                  <button onClick={()=>setGuest(u.id,Math.max(0,extra-1))}
                    disabled={extra===0}
                    style={{width:28,height:28,borderRadius:5,border:`1.5px solid ${T.border2}`,
                      background:T.surface2,color:T.text,cursor:extra===0?"default":"pointer",
                      fontSize:16,lineHeight:1,opacity:extra===0?.4:1}}>−</button>
                  <span style={{fontFamily:"'Cinzel',serif",fontSize:14,fontWeight:700,color:extra>0?T.amber:T.muted,
                    width:28,textAlign:"center"}}>+{extra}</span>
                  <button onClick={()=>setGuest(u.id,extra+1)}
                    style={{width:28,height:28,borderRadius:5,border:`1.5px solid ${T.border2}`,
                      background:T.surface2,color:T.text,cursor:"pointer",fontSize:16,lineHeight:1}}>+</button>
                </div>
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Crew Payments ── */}
      <Card style={{background:T.bgMid,marginBottom:16}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:4}}>
          <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,letterSpacing:".04em"}}>💳 Crew Payments</h4>
          {totalCrewPayments>0&&<span style={{fontFamily:"'Cinzel',serif",fontSize:12,color:"#4ADE80",fontWeight:700}}>
            −${totalCrewPayments.toFixed(2)} credited
          </span>}
        </div>
        <p style={{fontSize:12,color:T.hint,marginBottom:14}}>
          Manifest receipts are automatically credited to each crew member. Add manual payments for large up-front costs (e.g. Den paid $1,200 for the cottage deposit).
        </p>
        <div style={{display:"flex",flexDirection:"column",gap:12}}>
          {uList.map(u=>{
            const payments=paymentsMap[u.id]||[];
            const uReceipts=receiptsByUser(u.id);
            const receiptTotal=receiptTotalByUser(u.id);
            const manualTotal=manualPaidByUser(u.id);
            const total=paidByUser(u.id);
            const rank=CREW_RANKS[u.crewRank||"Enlisted"]||CREW_RANKS["Enlisted"];
            const hasAny=payments.length>0||uReceipts.length>0;
            return(
              <div key={u.id} style={{padding:"10px 12px",background:T.surface,borderRadius:8,
                border:`1px solid ${total>0?"#166534":T.border}`}}>
                {/* Header row */}
                <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:hasAny?10:0}}>
                  <Avatar name={u.name} picture={u.picture} size={30}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:5}}>
                      <span style={{fontSize:13,color:T.text,fontWeight:500}}>{u.name}</span>
                      <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:rank.bg,
                        color:rank.text,border:`1px solid ${rank.border}`,fontFamily:"'Cinzel',serif",fontWeight:700}}>{rank.icon}</span>
                    </div>
                    {total>0&&<span style={{fontSize:11,color:"#4ADE80"}}>
                      Paid ${total.toFixed(2)} total
                      {receiptTotal>0&&manualTotal>0&&<span style={{color:T.hint}}> (${receiptTotal.toFixed(2)} receipts + ${manualTotal.toFixed(2)} manual)</span>}
                    </span>}
                  </div>
                  <button onClick={()=>addPayment(u.id)}
                    style={{fontSize:11,padding:"4px 10px",borderRadius:5,border:`1.5px solid ${T.border2}`,
                      background:T.surface2,color:T.muted,cursor:"pointer",fontFamily:"'Cinzel',serif",
                      letterSpacing:".04em",flexShrink:0}}>+ Manual</button>
                </div>

                {/* Manifest receipts — read-only */}
                {uReceipts.length>0&&(
                  <div style={{marginBottom:payments.length?8:0}}>
                    <div style={{fontSize:10,color:T.hint,fontFamily:"'Cinzel',serif",letterSpacing:".05em",
                      textTransform:"uppercase",marginBottom:5}}>🧾 Manifest Receipts</div>
                    {uReceipts.map(r=>(
                      <div key={r.id} style={{display:"flex",alignItems:"center",gap:8,padding:"5px 8px",
                        borderRadius:5,background:T.bgMid,border:`1px solid ${T.border}`,marginBottom:4}}>
                        {r.image&&<img src={r.image} alt="" style={{width:28,height:28,objectFit:"cover",
                          borderRadius:3,flexShrink:0}}/>}
                        <span style={{flex:1,fontSize:12,color:T.muted,minWidth:0,overflow:"hidden",
                          textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.desc||"Receipt"}</span>
                        <span style={{fontFamily:"'Cinzel',serif",fontSize:12,color:"#4ADE80",
                          fontWeight:700,flexShrink:0}}>${parseFloat(r.amount||0).toFixed(2)}</span>
                      </div>
                    ))}
                    {uReceipts.length>1&&<div style={{fontSize:10,color:T.hint,textAlign:"right",
                      padding:"2px 4px"}}>Subtotal: ${receiptTotal.toFixed(2)}</div>}
                  </div>
                )}

                {/* Manual payments */}
                {payments.length>0&&(
                  <div>
                    <div style={{fontSize:10,color:T.hint,fontFamily:"'Cinzel',serif",letterSpacing:".05em",
                      textTransform:"uppercase",marginBottom:5}}>💳 Manual Payments</div>
                    {payments.map((p,i)=>(
                      <CCPaymentEntry key={i} desc={p.desc} amount={p.amount}
                        onChange={val=>updatePayment(u.id,i,val)}
                        onRemove={()=>removePayment(u.id,i)}/>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </Card>

      {/* ── Split Calculator ── */}
      {netTotal>0&&<Card style={{background:T.bgMid}}>
        <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,marginBottom:14,letterSpacing:".04em"}}>💸 Split Calculator</h4>
        <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:14}}>
          {[["all",`All (${totalHeads} heads)`],["adults",`Officers only`],["custom","Custom"]].map(([v,l])=>(
            <button key={v} onClick={()=>{setSplitMode(v);setDirty(true);}}
              style={{fontFamily:"'Cinzel',serif",fontSize:12,fontWeight:700,padding:"7px 14px",
                borderRadius:5,cursor:"pointer",transition:"all .15s",
                border:`2px solid ${splitMode===v?T.amber:T.border}`,
                background:splitMode===v?T.amberSoft:"transparent",
                color:splitMode===v?T.amber:T.muted}}>{l}</button>
          ))}
        </div>
        {splitMode==="custom"&&<CCNumInput label="Number splitting" value={customCount} onChange={markDirty(setCustomCount)} style={{marginBottom:14}}/>}

        <div style={{background:T.surface,border:`2px solid ${T.amber}55`,borderRadius:8,
          padding:"16px 20px",display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:16}}>
          <div>
            <div style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.muted,letterSpacing:".04em",marginBottom:4}}>PER HEAD</div>
            <div style={{fontSize:11,color:T.hint}}>${netTotal.toFixed(2)} ÷ {splitCount} people</div>
          </div>
          <div style={{fontFamily:"'Cinzel',serif",fontSize:28,fontWeight:700,color:T.amber,
            textShadow:`0 0 20px ${T.amber}88`}}>${perHead.toFixed(2)}</div>
        </div>

        {/* Individual breakdown */}
        {splitMode==="all"&&<div>
          <div style={{fontSize:11,color:T.hint,fontFamily:"'Cinzel',serif",letterSpacing:".04em",
            textTransform:"uppercase",marginBottom:8}}>Individual amounts</div>
          <div style={{display:"flex",flexDirection:"column",gap:6}}>
            {uList.map(u=>{
              const rank=CREW_RANKS[u.crewRank||"Enlisted"]||CREW_RANKS["Enlisted"];
              const mult=getMultiplier(u.id);
              const owes=perHead*mult;
              const depCredit=u.deposit?mult*depositAmt:0;
              const userPaid=paidByUser(u.id);
              const net=owes-depCredit-userPaid;
              return(
                <div key={u.id} style={{display:"flex",alignItems:"center",gap:10,
                  padding:"9px 12px",background:T.surface,borderRadius:7,border:`1px solid ${T.border}`}}>
                  <Avatar name={u.name} picture={u.picture} size={32}/>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{display:"flex",alignItems:"center",gap:5,flexWrap:"wrap"}}>
                      <span style={{fontSize:13,color:T.text,fontWeight:500}}>{u.name}</span>
                      <span style={{fontSize:9,padding:"1px 5px",borderRadius:3,background:rank.bg,
                        color:rank.text,border:`1px solid ${rank.border}`,fontFamily:"'Cinzel',serif",fontWeight:700}}>{rank.icon}</span>
                      {mult>1&&<span style={{fontSize:10,color:T.steam,background:T.steamSoft,
                        padding:"1px 6px",borderRadius:3,border:`1px solid ${T.steam}44`}}>×{mult} guests</span>}
                    </div>
                    <div style={{fontSize:11,color:T.hint,marginTop:2}}>
                      {mult} × ${perHead.toFixed(2)}
                      {depCredit>0?` − $${depCredit.toFixed(2)} dep`:""}
                      {userPaid>0?` − $${userPaid.toFixed(2)} paid`:""}
                    </div>
                  </div>
                  <div style={{textAlign:"right",flexShrink:0}}>
                    <div style={{fontFamily:"'Cinzel',serif",fontSize:15,fontWeight:700,
                      color:net<=0?"#4ADE80":T.amber}}>
                      {net<=0?`✓ overpaid $${Math.abs(net).toFixed(2)}`:`$${net.toFixed(2)}`}
                    </div>
                    <div style={{fontSize:10,color:u.deposit?"#4ADE80":T.hint}}>
                      {u.deposit?"💰 dep. paid":"⏳ dep. due"}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>}
      </Card>}
    </div>
  );
}

// ── GamesPlayedLogger — Personal Log section ─────────────────────────────────
function GamesPlayedLogger({authUser, profile, games, doLogGamePlayed, doRemoveGamePlayed, showToast}){
  const [query,  setQuery]  = useState("");
  const [adding, setAdding] = useState(false);

  const played   = profile?.gamesPlayed || [];
  const uid      = authUser?.uid;
  const gameList = games.filter(g=>!g.isRequest);

  // Suggestions: games in cargo hold not yet logged
  const suggestions = query.trim().length > 0
    ? gameList.filter(g=>g.name.toLowerCase().includes(query.toLowerCase()) && !played.includes(g.name))
    : gameList.filter(g=>!played.includes(g.name)).slice(0,5);

  const log = async (name) => {
    if(!name.trim() || !uid) return;
    setAdding(true);
    await doLogGamePlayed(uid, name.trim());
    setQuery("");
    showToast(`🎲 ${name} logged!`);
    setAdding(false);
  };

  const remove = async (name) => {
    if(!uid) return;
    await doRemoveGamePlayed(uid, name);
    showToast(`Removed ${name} from played games.`);
  };

  return (
    <div>
      <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:12}}>
        <span style={{fontSize:18}}>🎮</span>
        <h4 style={{fontFamily:"'Cinzel',serif",fontSize:12,color:T.amber,letterSpacing:".04em"}}>
          Games Played This Trip
        </h4>
      </div>

      {/* Played badges */}
      {played.length > 0
        ? <div style={{display:"flex",flexWrap:"wrap",gap:8,marginBottom:14}}>
            {played.map(name=>{
              const gb = gameBadge(name);
              return (
                <div key={name} style={{display:"flex",alignItems:"center",gap:5,
                  padding:"5px 10px 5px 8px",borderRadius:20,
                  background:gb.bg,border:`1.5px solid ${gb.border}`}}>
                  <div style={{width:22,height:22,borderRadius:5,background:gb.border+"44",
                    display:"flex",alignItems:"center",justifyContent:"center",
                    fontFamily:"'Cinzel',serif",fontSize:8,fontWeight:700,color:gb.text,flexShrink:0}}>
                    {gb.initials}
                  </div>
                  <span style={{fontSize:12,color:gb.text,fontWeight:600,whiteSpace:"nowrap"}}>{name}</span>
                  <button onClick={()=>remove(name)}
                    style={{background:"none",border:"none",cursor:"pointer",color:gb.border,
                      fontSize:14,lineHeight:1,padding:"0 0 0 2px",opacity:.6,flexShrink:0}}
                    title={`Remove ${name}`}>×</button>
                </div>
              );
            })}
          </div>
        : <p style={{fontSize:12,color:T.hint,fontStyle:"italic",marginBottom:14}}>
            No games logged yet — play something and record it here!
          </p>}

      {/* Add a game */}
      <div style={{position:"relative"}}>
        <input
          value={query}
          onChange={e=>setQuery(e.target.value)}
          onKeyDown={e=>{ if(e.key==="Enter"&&query.trim()){ log(query); } }}
          placeholder="Search or type a game name…"
          style={{width:"100%",fontFamily:"inherit",fontSize:13,padding:"8px 12px",
            borderRadius:6,border:`2px solid ${T.border2}`,background:T.surface2,
            color:T.text,outline:"none",boxSizing:"border-box"}}
        />
        {/* Dropdown suggestions */}
        {(suggestions.length > 0 || query.trim().length > 0) && (
          <div style={{position:"absolute",top:"100%",left:0,right:0,zIndex:200,
            background:T.surface,border:`1.5px solid ${T.border2}`,borderRadius:6,
            boxShadow:"0 8px 24px rgba(0,0,0,.4)",marginTop:4,overflow:"hidden"}}>
            {suggestions.map(g=>{
              const gb=gameBadge(g.name);
              return (
                <div key={g.id} onClick={()=>log(g.name)}
                  style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",
                    cursor:"pointer",borderBottom:`1px solid ${T.border}`}}
                  onMouseEnter={e=>e.currentTarget.style.background=T.amberSoft}
                  onMouseLeave={e=>e.currentTarget.style.background=""}>
                  <div style={{width:28,height:28,borderRadius:5,
                    background:gb.bg,border:`1.5px solid ${gb.border}`,
                    display:"flex",alignItems:"center",justifyContent:"center",
                    fontFamily:"'Cinzel',serif",fontSize:9,fontWeight:700,color:gb.text,flexShrink:0}}>
                    {gb.initials}
                  </div>
                  <div style={{flex:1,minWidth:0}}>
                    <div style={{fontSize:13,color:T.text,fontWeight:500}}>{g.name}</div>
                    {g.category&&<div style={{fontSize:10,color:T.hint}}>{g.category}</div>}
                  </div>
                </div>
              );
            })}
            {/* Allow logging a custom name not in cargo hold */}
            {query.trim().length > 0 && !gameList.find(g=>g.name.toLowerCase()===query.toLowerCase()) && (
              <div onClick={()=>log(query)}
                style={{display:"flex",alignItems:"center",gap:10,padding:"9px 12px",cursor:"pointer"}}
                onMouseEnter={e=>e.currentTarget.style.background=T.amberSoft}
                onMouseLeave={e=>e.currentTarget.style.background=""}>
                <div style={{width:28,height:28,borderRadius:5,background:T.amberSoft,
                  border:`1.5px solid ${T.amber}`,display:"flex",alignItems:"center",
                  justifyContent:"center",fontSize:14,flexShrink:0}}>＋</div>
                <span style={{fontSize:13,color:T.amber}}>Log "{query.trim()}"</span>
              </div>
            )}
          </div>
        )}
      </div>
      {adding&&<div style={{fontSize:11,color:T.steam,marginTop:6}}>⚙️ Logging…</div>}
      <p style={{fontSize:11,color:T.hint,marginTop:8}}>
        Games in the Cargo Hold appear as suggestions. You can also type any game name.
      </p>
    </div>
  );
}
