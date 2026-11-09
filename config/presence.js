// Présence en temps réel (socket.io) : chaque page de l'espace administrateur ouverte garde
// une connexion. Un soignant est en ligne tant qu'il lui reste au moins une connexion.
// À chaque arrivée et à chaque départ, la liste détaillée (« presence » : noms, photos) n'est
// envoyée qu'au personnel connecté au même établissement ; tout le personnel reçoit seulement les
// identifiants des soignants en ligne (« presence:ids », pastilles des discussions).
// L'application mobile des patientes se connecte aussi : le personnel reçoit les identifiants des
// patientes en ligne (« presence:patientes »), les patientes ceux des soignants en ligne
// (« presence:soignants ») — des identifiants seulement, les noms viennent de l'API.
// L'application ami-connecte-chauffeur se connecte aussi : le personnel reçoit les identifiants
// des chauffeurs en ligne (« presence:chauffeurs ») et leurs positions GPS (suiviAmbulances.js).
// L'application RECO se connecte aussi (messagerie) : le personnel reçoit les identifiants des RECO
// en ligne (« presence:recos ») ; les RECO, ceux des soignants et chauffeurs en ligne (« presence:ids »).
const jwt = require('jsonwebtoken');
const Soignant = require('../models/Soignant');
const Patiente = require('../models/Patiente');
const Etablissement = require('../models/Etablissement');
const Discussion = require('../models/Discussion');
const Chauffeur = require('../models/Chauffeur');
const Reco = require('../models/Reco');
const MembreComite = require('../models/MembreComite');
const suiviAmbulances = require('./suiviAmbulances');

const SALLE = 'personnel';
/** Groupe de pilotage : médecins chefs et membres du comité (messages du groupe). */
const SALLE_PILOTAGE = 'pilotage';
const ROLE_CHEF = 'Médecin chef de service';
const SALLE_PATIENTES = 'patientes';
const SALLE_RECOS = 'recos';
/** Personnel connecté sans établissement : liste détaillée limitée à ce groupe. */
const SALLE_SANS_ETABLISSEMENT = 'personnel:sans-etablissement';

/**
 * id du soignant → { profil, connexions } ; connexions : socket → établissement de connexion
 * (plusieurs onglets ou appareils possibles, éventuellement dans des établissements différents).
 */
const connectes = new Map();
/** id de la patiente → ses connexions (téléphone, navigateur…). */
const patientesConnectees = new Map();
/** id du chauffeur → ses connexions (application chauffeur). */
const chauffeursConnectes = new Map();
/** id du RECO → ses connexions (application RECO). */
const recosConnectes = new Map();
let io = null;

const salleEtablissement = (etablissementId) => (etablissementId ? `etablissement:${etablissementId}` : SALLE_SANS_ETABLISSEMENT);

/** Soignants ayant au moins une connexion ouverte dans l'établissement (null : sans établissement). */
function enLigneDans(etablissementId) {
  const liste = [];
  for (const { profil, connexions } of connectes.values()) {
    const ici = [...connexions.values()].filter((x) => x.etablissementId === etablissementId);
    if (!ici.length) continue;
    const connecteDepuis = new Date(Math.min(...ici.map((x) => x.connecteDepuis)));
    liste.push({ ...profil, etablissement: ici[0].etablissement, etablissementId, connecteDepuis });
  }
  return liste;
}

/** Listes à jour pour les établissements concernés ; identifiants à tout le personnel et aux patientes. */
function diffuser(etablissementIds) {
  for (const e of new Set(etablissementIds)) io?.to(salleEtablissement(e)).emit('presence', enLigneDans(e));
  io?.to(SALLE).emit('presence:ids', [...connectes.keys()]);
  io?.to(SALLE_PATIENTES).emit('presence:soignants', [...connectes.keys()]);
  diffuserAuxRecos();
}

/** Les RECO voient qui, parmi leurs contacts (soignants, chauffeurs), est en ligne. */
function diffuserAuxRecos() {
  io?.to(SALLE_RECOS).emit('presence:ids', [...connectes.keys(), ...chauffeursConnectes.keys()]);
}

function diffuserRecos() {
  io?.to(SALLE).emit('presence:recos', [...recosConnectes.keys()]);
}

function diffuserPatientes() {
  io?.to(SALLE).emit('presence:patientes', [...patientesConnectees.keys()]);
}

function diffuserChauffeurs() {
  io?.to(SALLE).emit('presence:chauffeurs', [...chauffeursConnectes.keys()]);
  diffuserAuxRecos();
}

const profilDe = (soignant) => ({
  id: soignant.id, prenom: soignant.prenom, nom: soignant.nom, postnom: soignant.postnom,
  role: soignant.role, matricule: soignant.matricule, photo: soignant.photo ?? null, sexe: soignant.sexe,
});

async function nomEtablissement(etablissementId) {
  const [etablissement] = etablissementId ? await Etablissement.actifsParIds([etablissementId]) : [];
  return etablissement?.nom ?? null;
}

function initialiser(serveur) {
  io = serveur;

  // Même jeton JWT que l'API : personnel actif, patiente dont l'espace est activé ou chauffeur actif.
  io.use(async (socket, next) => {
    try {
      const { sub, etablissement, typ } = jwt.verify(String(socket.handshake.auth?.jeton || ''), process.env.JWT_SECRET);
      if (typ === 'chauffeur') {
        const chauffeur = await Chauffeur.findById(sub).select('statut');
        if (!chauffeur || chauffeur.statut !== 'Actif') return next(new Error('Compte inactif ou introuvable.'));
        socket.data.chauffeurId = chauffeur.id;
        return next();
      }
      if (typ === 'reco') {
        // Même contrôle que l'API : compte actif, jeton émis après la dernière révocation.
        const { iat } = jwt.decode(String(socket.handshake.auth?.jeton || ''));
        const reco = await Reco.findById(sub).select('statut sessionsRevoqueesLe');
        if (!reco || reco.statut !== 'Actif') return next(new Error('Compte inactif ou introuvable.'));
        if (reco.sessionsRevoqueesLe && iat * 1000 < reco.sessionsRevoqueesLe.getTime()) return next(new Error('Session révoquée, reconnectez-vous.'));
        socket.data.recoId = reco.id;
        return next();
      }
      if (typ === 'comite') {
        const membre = await MembreComite.findById(sub).select('statut');
        if (!membre || membre.statut !== 'Actif') return next(new Error('Compte inactif ou introuvable.'));
        socket.data.comiteId = membre.id;
        return next();
      }
      if (typ === 'patiente') {
        const patiente = await Patiente.findById(sub).select('espaceEnLigne');
        if (!patiente || patiente.espaceEnLigne !== 'Activé') return next(new Error('Compte inactif ou introuvable.'));
        socket.data.patienteId = patiente.id;
        return next();
      }
      const soignant = await Soignant.findById(sub);
      if (!soignant || soignant.statut !== 'Actif') return next(new Error('Compte inactif ou introuvable.'));
      socket.data.soignant = soignant;
      socket.data.etablissementId = etablissement ?? null;
      next();
    } catch {
      next(new Error('Session expirée, reconnectez-vous.'));
    }
  });

  io.on('connection', async (socket) => {
    if (socket.data.patienteId) return connecterPatiente(socket);
    if (socket.data.chauffeurId) return connecterChauffeur(socket);
    if (socket.data.recoId) return connecterReco(socket);
    if (socket.data.comiteId) return connecterComite(socket);
    const { soignant } = socket.data;
    const etablissementId = socket.data.etablissementId ?? null;
    const id = soignant.id;

    socket.on('discussion:ecrit', (donnees) => relayerEcriture(socket, id, donnees));
    // Médecin chef : membre du groupe de pilotage (avec le comité).
    if (soignant.role === ROLE_CHEF) {
      socket.join(SALLE_PILOTAGE);
      socket.on('groupe:ecrit', () => relayerEcritureGroupe(socket, id));
    }

    socket.on('disconnect', () => {
      const c = connectes.get(id);
      if (!c?.connexions.delete(socket.id)) return;
      if (!c.connexions.size) connectes.delete(id);
      diffuser([etablissementId]);
    });

    const etablissement = await nomEtablissement(etablissementId);
    if (!socket.connected) return; // parti pendant la lecture de l'établissement
    socket.join([SALLE, `soignant:${id}`, salleEtablissement(etablissementId)]);
    const c = connectes.get(id) ?? { profil: profilDe(soignant), connexions: new Map() };
    c.connexions.set(socket.id, { etablissementId, etablissement, connecteDepuis: new Date() });
    connectes.set(id, c);
    diffuser([etablissementId]);
    socket.emit('presence:patientes', [...patientesConnectees.keys()]);
    socket.emit('presence:chauffeurs', [...chauffeursConnectes.keys()]);
    socket.emit('presence:recos', [...recosConnectes.keys()]);
  });
}

/** RECO (application RECO) : messagerie avec les soignants et les chauffeurs de son établissement. */
function connecterReco(socket) {
  const id = socket.data.recoId;
  socket.on('discussion:ecrit', (donnees) => relayerEcriture(socket, id, donnees));
  socket.on('disconnect', () => {
    const s = recosConnectes.get(id);
    if (!s?.delete(socket.id)) return;
    if (!s.size) {
      recosConnectes.delete(id);
      diffuserRecos();
    }
  });
  socket.join([SALLE_RECOS, `reco:${id}`]);
  const s = recosConnectes.get(id) ?? new Set();
  s.add(socket.id);
  recosConnectes.set(id, s);
  socket.emit('presence:ids', [...connectes.keys(), ...chauffeursConnectes.keys()]);
  diffuserRecos();
}

/** Chauffeur (application ami-connecte-chauffeur) : envoie sa position GPS chaque seconde. */
function connecterChauffeur(socket) {
  const id = socket.data.chauffeurId;
  socket.on('discussion:ecrit', (donnees) => relayerEcriture(socket, id, donnees));
  socket.on('position', (donnees, accuse) => {
    suiviAmbulances.enregistrerPosition(id, donnees)
      .then((m) => typeof accuse === 'function' && accuse({ ok: !!m }))
      .catch(() => typeof accuse === 'function' && accuse({ ok: false }));
  });
  socket.on('disconnect', () => {
    const s = chauffeursConnectes.get(id);
    if (!s?.delete(socket.id)) return;
    if (!s.size) {
      chauffeursConnectes.delete(id);
      diffuserChauffeurs();
    }
  });
  socket.join(`chauffeur:${id}`);
  const s = chauffeursConnectes.get(id) ?? new Set();
  s.add(socket.id);
  chauffeursConnectes.set(id, s);
  diffuserChauffeurs();
}

/** Patiente (application mobile) : en ligne tant qu'il lui reste une connexion. */
function connecterPatiente(socket) {
  const id = socket.data.patienteId;
  socket.on('discussion:ecrit', (donnees) => relayerEcriture(socket, id, donnees));
  socket.on('disconnect', () => {
    const s = patientesConnectees.get(id);
    if (!s?.delete(socket.id)) return;
    if (!s.size) {
      patientesConnectees.delete(id);
      diffuserPatientes();
    }
  });
  socket.join([SALLE_PATIENTES, `patiente:${id}`]);
  const s = patientesConnectees.get(id) ?? new Set();
  s.add(socket.id);
  patientesConnectees.set(id, s);
  socket.emit('presence:soignants', [...connectes.keys()]);
  diffuserPatientes();
}

/**
 * Membre du comité de pilotage : reçoit ses messages privés (avec les médecins chefs) et ceux du
 * groupe de pilotage ; voit quels soignants sont en ligne (identifiants seulement).
 */
function connecterComite(socket) {
  const id = socket.data.comiteId;
  socket.on('discussion:ecrit', (donnees) => relayerEcriture(socket, id, donnees));
  socket.on('groupe:ecrit', () => relayerEcritureGroupe(socket, id));
  socket.join([`comite:${id}`, SALLE_PILOTAGE]);
  socket.emit('presence:ids', [...connectes.keys()]);
}

/** « En train d'écrire » dans le groupe de pilotage : relayé aux autres membres du groupe. */
function relayerEcritureGroupe(socket, id) {
  const maintenant = Date.now();
  if (maintenant - (socket.data.dernierEcritGroupe || 0) < 1500) return;
  socket.data.dernierEcritGroupe = maintenant;
  socket.to(SALLE_PILOTAGE).emit('groupe:ecrit', { auteurId: id });
}

/** Événement adressé à tout le groupe de pilotage (médecins chefs et comité connectés). */
function emettrePilotage(evenement, donnees) {
  io?.to(SALLE_PILOTAGE).emit(evenement, donnees);
}

/** « En train d'écrire » : relayé seulement à l'autre participant de la discussion. */
async function relayerEcriture(socket, id, donnees) {
  const discussionId = String(donnees?.discussionId || '');
  if (!/^[a-f0-9]{24}$/.test(discussionId)) return;
  const maintenant = Date.now();
  if (maintenant - (socket.data.dernierEcrit || 0) < 1500) return; // anti-saturation
  socket.data.dernierEcrit = maintenant;
  const d = await Discussion.findById(discussionId).select('participants').lean().catch(() => null);
  if (!d || !d.participants.some((p) => String(p) === id)) return;
  for (const p of d.participants) {
    if (String(p) !== id) emettre(String(p), 'discussion:ecrit', { discussionId, soignantId: id });
  }
}

/** Événement temps réel adressé à toutes les connexions d'un participant (soignant, patiente, RECO ou chauffeur). */
function emettre(id, evenement, donnees) {
  io?.to([`soignant:${id}`, `patiente:${id}`, `reco:${id}`, `chauffeur:${id}`, `comite:${id}`]).emit(evenement, donnees);
}

/** Événement adressé à tout le personnel connecté (urgences, flotte). */
function emettrePersonnel(evenement, donnees) {
  io?.to(SALLE).emit(evenement, donnees);
}

/**
 * Événement adressé au personnel connecté à un établissement (sa flotte, ses urgences). Sans
 * établissement (urgence d'une patiente non rattachée) : tout le personnel, pour qu'elle ne
 * reste jamais sans réponse.
 */
function emettreEtablissement(etablissementId, evenement, donnees) {
  io?.to(etablissementId ? `etablissement:${etablissementId}` : SALLE).emit(evenement, donnees);
}

function emettrePatiente(id, evenement, donnees) {
  io?.to(`patiente:${id}`).emit(evenement, donnees);
}

function emettreChauffeur(id, evenement, donnees) {
  io?.to(`chauffeur:${id}`).emit(evenement, donnees);
}

/** Ferme les connexions d'un chauffeur (compte suspendu ou supprimé). */
function expulserChauffeur(id) {
  io?.in(`chauffeur:${id}`).disconnectSockets(true);
}

/** Ferme les connexions d'un RECO (compte suspendu, sessions révoquées ou supprimé). */
function expulserReco(id) {
  io?.in(`reco:${id}`).disconnectSockets(true);
}

/** Ferme toutes les connexions d'un soignant (compte suspendu ou supprimé). */
function expulser(id) {
  io?.in(`soignant:${id}`).disconnectSockets(true);
}

/** Profil modifié (nom, photo…) : la liste en ligne est mise à jour pour tous. */
async function actualiser(soignant) {
  const c = connectes.get(soignant.id);
  if (!c) return;
  c.profil = profilDe(soignant);
  diffuser([...c.connexions.values()].map((x) => x.etablissementId));
}

module.exports = {
  initialiser, expulser, actualiser, emettre, emettrePersonnel, emettreEtablissement, emettrePatiente, emettreChauffeur, expulserChauffeur, expulserReco,
  emettrePilotage, expulserComite,
};

/** Ferme les connexions d'un membre du comité (compte retiré). */
function expulserComite(id) {
  io?.in(`comite:${id}`).disconnectSockets(true);
}
