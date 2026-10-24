// Notifications push de l'application mobile (Firebase Cloud Messaging).
// Clé du compte de service : FIREBASE_SERVICE_ACCOUNT (contenu JSON, pratique en production) ou
// FIREBASE_SERVICE_ACCOUNT_FILE (chemin du fichier .json, relatif à la racine du backend).
// Sans clé (poste de développement), les envois sont ignorés sans erreur ; de même pendant les tests
// (node --test), qui ne doivent jamais joindre Firebase.
//
// Les textes restent discrets (écran verrouillé) : jamais de contenu médical ni de message.
const path = require('path');
const Patiente = require('../models/Patiente');
const r2 = require('./r2');

/** Jetons à oublier : application désinstallée ou jeton remplacé. */
const JETONS_PERIMES = ['messaging/registration-token-not-registered', 'messaging/invalid-registration-token', 'messaging/invalid-argument'];
const MAX_APPAREILS = 5;
/** Lien signé d'une photo de notification : le téléphone peut la télécharger plus tard (hors ligne). */
const DUREE_LIEN_PHOTO_S = 24 * 3600;
/** Limite de Firebase pour un envoi groupé. */
const JETONS_PAR_ENVOI = 500;

let messagerie;

function compteDeService() {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) return JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  if (process.env.FIREBASE_SERVICE_ACCOUNT_FILE) return require(path.resolve(__dirname, '..', process.env.FIREBASE_SERVICE_ACCOUNT_FILE));
  return null;
}

/**
 * Client Firebase Messaging, initialisé au premier envoi ; null si Firebase n'est pas configuré.
 * Les envois l'appellent par module.exports : les tests le remplacent par un faux client.
 */
function client() {
  if (messagerie !== undefined) return messagerie;
  try {
    const compte = process.env.NODE_TEST_CONTEXT ? null : compteDeService();
    if (!compte) return (messagerie = null);
    const { initializeApp, cert } = require('firebase-admin/app');
    const { getMessaging } = require('firebase-admin/messaging');
    messagerie = getMessaging(initializeApp({ credential: cert(compte) }, 'ami-connecte'));
    console.log(`Notifications push : Firebase configuré (projet ${compte.project_id}).`);
  } catch (err) {
    console.error('Notifications push : configuration Firebase invalide :', err.message);
    messagerie = null;
  }
  return messagerie;
}

/** Photo d'un soignant pour une notification (lien signé de 24 h, sinon URL https enregistrée) ; null sans photo. */
async function photoNotification(soignant) {
  if (!soignant) return null;
  const signee = soignant.photoCle ? await r2.urlSignee(soignant.photoCle, DUREE_LIEN_PHOTO_S) : null;
  return signee ?? (soignant.photo?.startsWith('https://') ? soignant.photo : null);
}

/** Enregistre le téléphone de la patiente (un même jeton n'est gardé qu'une fois). */
async function enregistrerAppareil(patienteId, jeton, plateforme) {
  await Patiente.updateOne({ _id: patienteId }, { $pull: { appareils: { jeton } } });
  await Patiente.updateOne({ _id: patienteId }, {
    $push: { appareils: { $each: [{ jeton, plateforme, le: new Date() }], $slice: -MAX_APPAREILS } },
  });
}

async function retirerAppareil(patienteId, jeton) {
  await Patiente.updateOne({ _id: patienteId }, { $pull: { appareils: { jeton } } });
}

/**
 * Message Firebase : `donnees` (chaînes) indique à l'application quelle page ouvrir au toucher ;
 * `image` (URL https joignable par le téléphone) s'affiche en grand dans la notification.
 */
const message = ({ titre, corps, donnees = {}, image }) => ({
  notification: { title: titre, body: corps, ...(image ? { imageUrl: image } : {}) },
  data: Object.fromEntries(Object.entries(donnees).map(([k, v]) => [k, String(v)])),
  android: { priority: 'high', notification: { channelId: 'ami-general', color: '#0055a5', icon: 'ic_stat_notification' } },
  // mutable-content : iOS laisse l'extension de notification télécharger l'image.
  apns: { payload: { aps: { sound: 'default', ...(image ? { 'mutable-content': 1 } : {}) } }, ...(image ? { fcmOptions: { imageUrl: image } } : {}) },
});

/** Envoi à une liste de jetons ; renvoie le nombre de téléphones atteints et les jetons périmés. */
async function envoyer(fcm, jetons, contenu) {
  let atteints = 0;
  const perimes = [];
  for (let i = 0; i < jetons.length; i += JETONS_PAR_ENVOI) {
    const lot = jetons.slice(i, i + JETONS_PAR_ENVOI);
    const r = await fcm.sendEachForMulticast({ tokens: lot, ...message(contenu) });
    atteints += r.successCount;
    perimes.push(...lot.filter((_, j) => JETONS_PERIMES.includes(r.responses[j].error?.code)));
  }
  return { atteints, perimes };
}

/**
 * Envoie une notification à tous les téléphones de la patiente ; renvoie true si au moins un
 * téléphone l'a reçue. Ne lève jamais d'erreur : la notification est un complément, l'action
 * qui la déclenche ne doit pas échouer à cause d'elle.
 */
async function notifierPatiente(patienteId, contenu) {
  try {
    const fcm = module.exports.client();
    if (!fcm || !patienteId) return false;
    const p = await Patiente.findById(patienteId).select('+appareils espaceEnLigne');
    if (!p || p.espaceEnLigne !== 'Activé' || !p.appareils.length) return false;
    const { atteints, perimes } = await envoyer(fcm, p.appareils.map((a) => a.jeton), contenu);
    if (perimes.length) await Patiente.updateOne({ _id: p._id }, { $pull: { appareils: { jeton: { $in: perimes } } } });
    return atteints > 0;
  } catch (err) {
    console.error('Notification push non envoyée :', err.message);
    return false;
  }
}

/**
 * Même notification à toutes les patientes (espace activé, application installée) répondant au
 * filtre — ex. nouvel article de conseils. Renvoie le nombre de téléphones atteints.
 */
async function notifierPatientes(filtre, contenu) {
  try {
    const fcm = module.exports.client();
    if (!fcm) return 0;
    const patientes = await Patiente.find({ ...filtre, espaceEnLigne: 'Activé', 'appareils.0': { $exists: true } }).select('+appareils');
    const jetons = patientes.flatMap((p) => p.appareils.map((a) => a.jeton));
    if (!jetons.length) return 0;
    const { atteints, perimes } = await envoyer(fcm, jetons, contenu);
    if (perimes.length) await Patiente.updateMany({ 'appareils.jeton': { $in: perimes } }, { $pull: { appareils: { jeton: { $in: perimes } } } });
    return atteints;
  } catch (err) {
    console.error('Notifications push non envoyées :', err.message);
    return 0;
  }
}

module.exports = { client, enregistrerAppareil, retirerAppareil, notifierPatiente, notifierPatientes, photoNotification };
