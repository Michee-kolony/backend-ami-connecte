// Suivi des ambulances en temps réel : l'application chauffeur envoie sa position GPS chaque
// seconde (socket.io, ou HTTP en secours). Elle est diffusée aussitôt au personnel et, pendant
// une mission, à la patiente secourue ; elle n'est enregistrée en base que toutes les 5 s.
const Ambulance = require('../models/Ambulance');
const Urgence = require('../models/Urgence');
const { INTERVALLE_POSITION_MS, INTERVALLE_SAUVEGARDE_MS } = require('./urgences');

/** Durée de validité du contexte d'un chauffeur (ambulance, mission) gardé en mémoire. */
const CONTEXTE_MS = 15000;

/** id du chauffeur → { code, numero, patienteId, dernierEnvoi, derniereSauvegarde, expire }. */
const contextes = new Map();

// Chargé à l'usage : presence.js charge aussi ce module.
const presence = () => require('./presence');

/** À appeler quand l'ambulance ou la mission d'un chauffeur change (affectation, clôture). */
function invalider(chauffeurId) {
  if (chauffeurId) contextes.delete(String(chauffeurId));
}

async function contexte(chauffeurId) {
  const id = String(chauffeurId);
  const actuel = contextes.get(id);
  if (actuel && actuel.expire > Date.now()) return actuel;
  const ambulance = await Ambulance.findOne({ chauffeurId: id }).select('code urgence').lean();
  if (!ambulance) {
    contextes.delete(id);
    return null;
  }
  const urgence = ambulance.urgence ? await Urgence.findOne({ numero: ambulance.urgence }).select('numero patienteId').lean() : null;
  const c = {
    code: ambulance.code,
    numero: urgence?.numero ?? null,
    patienteId: urgence ? String(urgence.patienteId) : null,
    dernierEnvoi: actuel?.dernierEnvoi ?? 0,
    derniereSauvegarde: actuel?.derniereSauvegarde ?? 0,
    expire: Date.now() + CONTEXTE_MS,
  };
  contextes.set(id, c);
  return c;
}

const fini = (v) => (v === null || v === undefined || v === '' ? null : Number.isFinite(Number(v)) ? Number(v) : null);

/** Position reçue du téléphone, vérifiée (null si invalide). */
function lirePosition(d) {
  const lat = fini(d?.lat);
  const lng = fini(d?.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const cap = fini(d.cap);
  const vitesse = fini(d.vitesse);
  const precision = fini(d.precision);
  return {
    lat, lng,
    cap: cap != null && cap >= 0 && cap <= 360 ? cap : null,
    vitesse: vitesse != null && vitesse >= 0 && vitesse < 400 ? Math.round(vitesse * 10) / 10 : null,
    precision: precision != null && precision >= 0 ? Math.round(precision) : null,
  };
}

/**
 * Nouvelle position du chauffeur : diffusée (au plus une fois par INTERVALLE_POSITION_MS) au
 * personnel et à la patiente en mission. Renvoie le message diffusé, ou null si ignorée.
 */
async function enregistrerPosition(chauffeurId, donnees) {
  const p = lirePosition(donnees);
  if (!p) return null;
  const c = await contexte(chauffeurId);
  if (!c) return null; // aucune ambulance confiée : rien à suivre
  const maintenant = Date.now();
  if (maintenant - c.dernierEnvoi < INTERVALLE_POSITION_MS) return null;
  c.dernierEnvoi = maintenant;
  const position = { ...p, le: new Date(maintenant) };
  if (maintenant - c.derniereSauvegarde >= INTERVALLE_SAUVEGARDE_MS) {
    c.derniereSauvegarde = maintenant;
    await Ambulance.updateOne({ code: c.code }, { position });
  }
  const message = { ambulance: c.code, urgence: c.numero, ...position };
  presence().emettrePersonnel('ambulance:position', message);
  if (c.patienteId) presence().emettrePatiente(c.patienteId, 'ambulance:position', message);
  return message;
}

module.exports = { enregistrerPosition, invalider, lirePosition };
