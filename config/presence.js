// Présence en temps réel (socket.io) : chaque page de l'espace administrateur ouverte garde
// une connexion. Un soignant est en ligne tant qu'il lui reste au moins une connexion ;
// la liste est diffusée à tout le personnel à chaque arrivée et à chaque départ.
// L'application mobile des patientes se connecte aussi : le personnel reçoit les identifiants des
// patientes en ligne (« presence:patientes »), les patientes ceux des soignants en ligne
// (« presence:soignants ») — des identifiants seulement, les noms viennent de l'API.
const jwt = require('jsonwebtoken');
const Soignant = require('../models/Soignant');
const Patiente = require('../models/Patiente');
const Etablissement = require('../models/Etablissement');
const Discussion = require('../models/Discussion');

const SALLE = 'personnel';
const SALLE_PATIENTES = 'patientes';

/** id du soignant → { infos, sockets } (plusieurs onglets ou appareils possibles). */
const connectes = new Map();
/** id de la patiente → ses connexions (téléphone, navigateur…). */
const patientesConnectees = new Map();
let io = null;

function diffuser() {
  io?.to(SALLE).emit('presence', [...connectes.values()].map((c) => c.infos));
  io?.to(SALLE_PATIENTES).emit('presence:soignants', [...connectes.keys()]);
}

function diffuserPatientes() {
  io?.to(SALLE).emit('presence:patientes', [...patientesConnectees.keys()]);
}

async function infosDe(soignant, etablissementId, connecteDepuis = new Date()) {
  const [etablissement] = etablissementId ? await Etablissement.actifsParIds([etablissementId]) : [];
  return {
    id: soignant.id, prenom: soignant.prenom, nom: soignant.nom, postnom: soignant.postnom,
    role: soignant.role, matricule: soignant.matricule, photo: soignant.photo ?? null, sexe: soignant.sexe,
    etablissement: etablissement?.nom ?? null, etablissementId: etablissementId ?? null, connecteDepuis,
  };
}

function initialiser(serveur) {
  io = serveur;

  // Même jeton JWT que l'API : personnel actif, ou patiente dont l'espace est activé.
  io.use(async (socket, next) => {
    try {
      const { sub, etablissement, typ } = jwt.verify(String(socket.handshake.auth?.jeton || ''), process.env.JWT_SECRET);
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
    const { soignant, etablissementId } = socket.data;
    const id = soignant.id;

    socket.on('discussion:ecrit', (donnees) => relayerEcriture(socket, id, donnees));

    socket.on('disconnect', () => {
      const c = connectes.get(id);
      if (!c?.sockets.delete(socket.id)) return;
      if (!c.sockets.size) {
        connectes.delete(id);
        diffuser();
      }
    });

    const infos = await infosDe(soignant, etablissementId);
    if (!socket.connected) return; // parti pendant la lecture de l'établissement
    socket.join([SALLE, `soignant:${id}`]);
    const c = connectes.get(id) ?? { infos, sockets: new Set() };
    c.sockets.add(socket.id);
    connectes.set(id, c);
    diffuser();
    socket.emit('presence:patientes', [...patientesConnectees.keys()]);
  });
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

/** Événement temps réel adressé à toutes les connexions d'un participant (soignant ou patiente). */
function emettre(id, evenement, donnees) {
  io?.to([`soignant:${id}`, `patiente:${id}`]).emit(evenement, donnees);
}

/** Ferme toutes les connexions d'un soignant (compte suspendu ou supprimé). */
function expulser(id) {
  io?.in(`soignant:${id}`).disconnectSockets(true);
}

/** Profil modifié (nom, photo…) : la liste en ligne est mise à jour pour tous. */
async function actualiser(soignant) {
  const c = connectes.get(soignant.id);
  if (!c) return;
  c.infos = await infosDe(soignant, c.infos.etablissementId, c.infos.connecteDepuis);
  diffuser();
}

module.exports = { initialiser, expulser, actualiser, emettre };
