// RECO attitré de chaque patiente (demande du médecin) : dès l'enregistrement CPN, la patiente est
// confiée à un relais communautaire de sa structure qui habite son secteur. Le RECO ne voit dans
// son application que les patientes qui lui sont confiées, et reçoit leurs alertes et leurs tâches
// de relance (config/moteurRelance.js attribue d'abord les tâches au RECO attitré).
//
// Choix automatique, parmi les RECO actifs de la structure :
//   1. ceux dont les zones couvrent le quartier de la patiente ;
//   2. sinon ceux dont les zones couvrent sa commune (ou sa ville) ;
//   3. sinon ceux de la même aire de santé ;
// à égalité, celui qui suit le moins de patientes (puis le matricule, pour un choix stable).
const Patiente = require('../models/Patiente');
const Reco = require('../models/Reco');
const TacheRelance = require('../models/TacheRelance');
const moteur = require('./moteurRelance');
const { AUTEUR_SYSTEME } = require('./relance');

const { normaliserZone } = Reco;
/** Patientes encore suivies (un dossier archivé libère le RECO). */
const SUIVIES = { statut: { $ne: 'Archivé' } };

const nomPatiente = (p) => [p.prenom, p.nom, p.postnom].filter(Boolean).join(' ');
const secteur = (p) => [p.adresse?.quartier, p.adresse?.commune].filter(Boolean).join(', ');

/** Nombre de patientes suivies par chaque RECO. */
async function patientesSuivies(recoIds) {
  const lignes = await Patiente.aggregate([
    { $match: { recoId: { $in: recoIds }, ...SUIVIES } },
    { $group: { _id: '$recoId', n: { $sum: 1 } } },
  ]);
  return new Map(lignes.map((l) => [String(l._id), l.n]));
}

/**
 * Précision avec laquelle le RECO couvre l'adresse : 0 quartier, 1 commune (ou ville), 2 aire de
 * santé (RECO sans zone précise : il couvre toute l'aire), 3 aire de santé (RECO affecté à
 * d'autres quartiers, en dernier recours), Infinity s'il ne la couvre pas.
 */
function niveau(reco, adresse = {}) {
  const quartier = normaliserZone(adresse.quartier);
  const commune = normaliserZone(adresse.commune);
  const aire = normaliserZone(adresse.aireSante);
  if (quartier && reco.zonesNormalisees.includes(quartier)) return 0;
  if (commune && reco.zonesNormalisees.includes(commune)) return 1;
  if (aire && normaliserZone(reco.aireSante) === aire) return reco.zonesNormalisees.length ? 3 : 2;
  return Infinity;
}

/** Candidats du secteur de la patiente : ceux du critère le plus précis atteint. */
function candidatsDuSecteur(recos, adresse = {}) {
  const meilleur = Math.min(...recos.map((x) => niveau(x, adresse)));
  return Number.isFinite(meilleur) ? recos.filter((x) => niveau(x, adresse) === meilleur) : [];
}

/** RECO à qui confier la patiente (null si aucun RECO actif ne couvre son secteur). */
async function choisirRecoPatiente(patiente) {
  if (!patiente.etablissementId) return null;
  const recos = await Reco.find({ statut: 'Actif', etablissementId: patiente.etablissementId }).select('+zonesNormalisees');
  const candidats = candidatsDuSecteur(recos, patiente.adresse);
  if (!candidats.length) return null;
  const suivies = await patientesSuivies(candidats.map((x) => x._id));
  return candidats.sort((x, y) => (suivies.get(x.id) ?? 0) - (suivies.get(y.id) ?? 0) || x.matricule.localeCompare(y.matricule))[0];
}

/** RECO désigné par le personnel : actif et rattaché à la structure de la patiente. */
async function recoDesigne(patiente, recoId) {
  const reco = await Reco.findOne({ _id: recoId, statut: 'Actif', etablissementId: patiente.etablissementId });
  return reco;
}

/**
 * Place le RECO sur le dossier (sans l'enregistrer). Renvoie { avant, apres } (identifiants)
 * pour prévenir les RECO concernés une fois le dossier enregistré (voir prevenir).
 */
function placer(patiente, reco, par, mode, le = new Date()) {
  const avant = patiente.recoId ? String(patiente.recoId) : null;
  patiente.recoId = reco?._id ?? null;
  patiente.recoAffectation = reco ? { mode, le, par } : null;
  return { avant, apres: reco ? reco.id : null };
}

/** Réattribue au nouveau RECO les tâches ouvertes de la patiente dans sa structure ; renvoie leurs numéros. */
async function transfererTaches(patiente, recoId, le) {
  const reco = await Reco.findById(recoId);
  if (!reco) return [];
  const taches = await TacheRelance.find({
    patienteId: patiente._id, ouverte: true, etablissementId: reco.etablissementId, recoId: { $ne: reco._id },
  });
  for (const t of taches) {
    moteur.attribuer(t, reco, patiente.recoAffectation?.par ?? AUTEUR_SYSTEME, { motif: 'RECO attitré de la patiente changé', le });
    await t.save();
  }
  return taches.map((t) => t.numero);
}

/** Alertes après un changement de RECO : nouveau RECO, ancien RECO, ou supervision si personne. */
async function prevenir(patiente, { avant, apres }, { nouvelle = false, le = new Date() } = {}) {
  // Rien n'a changé : pas d'alerte (sauf dossier nouveau resté sans RECO, signalé à la supervision).
  if (avant === apres && !(nouvelle && !apres)) return;
  const qui = `${nomPatiente(patiente)} (${patiente.numero})${secteur(patiente) ? ` — ${secteur(patiente)}` : ''}`;
  // Ses tâches de relance ouvertes suivent la patiente chez son nouveau RECO.
  const taches = apres ? await transfererTaches(patiente, apres, le) : [];
  if (taches.length) await moteur.alerter('attribution', { recoId: apres, taches }, le);
  if (apres) await moteur.alerter('patiente_affectee', { recoId: apres, message: `Nouvelle patiente confiée à votre suivi : ${qui}.` }, le);
  if (avant && avant !== apres) await moteur.alerter('patiente_retiree', { recoId: avant, message: `${qui} est désormais suivie par un autre RECO.` }, le);
  if (!apres) {
    await moteur.alerter('patiente_sans_reco', {
      etablissementId: patiente.etablissementId,
      message: `Aucun RECO actif ne couvre le quartier de ${qui} : désignez-en un dans son dossier, ou ajoutez ce quartier aux zones d’un RECO.`,
    }, le);
  }
}

/**
 * Affectation automatique (enregistrement, adresse modifiée, RECO suspendu) : un choix manuel
 * est gardé tant que son RECO reste actif dans la structure.
 */
async function affecterAutomatiquement(patiente, par, { forcer = false } = {}) {
  if (!forcer && patiente.recoAffectation?.mode === 'Manuelle' && patiente.recoId) {
    if (await recoDesigne(patiente, patiente.recoId)) return { avant: String(patiente.recoId), apres: String(patiente.recoId) };
  }
  return placer(patiente, await choisirRecoPatiente(patiente), par, 'Automatique');
}

/**
 * Le RECO quitte le suivi (suspendu, supprimé, changé de structure ou de zones) : ses patientes
 * sont confiées à un autre RECO de leur secteur ; celles qui restent sans RECO sont signalées.
 * Renvoie le nombre de patientes réaffectées.
 */
async function reaffecterPatientesDe(recoId, par) {
  const reco = await Reco.findById(recoId).select('+zonesNormalisees');
  const patientes = await Patiente.find({ recoId, ...SUIVIES });
  let n = 0;
  for (const p of patientes) {
    // Toujours actif dans la structure : il garde ses choix manuels et les patientes de son secteur.
    const actif = reco?.statut === 'Actif' && reco.etablissementId === p.etablissementId;
    if (actif && (p.recoAffectation?.mode === 'Manuelle' || Number.isFinite(niveau(reco, p.adresse)))) continue;
    const changement = placer(p, await choisirRecoPatiente(p), par, 'Automatique');
    await p.save();
    await prevenir(p, changement);
    n += 1;
  }
  return n;
}

/**
 * Nouveau RECO, réactivé ou zones élargies : il reprend les patientes de son secteur restées sans
 * RECO, et celles confiées automatiquement à un RECO qui couvre leur adresse moins précisément
 * (ex. par l'aire de santé alors que lui couvre leur quartier). Les choix manuels sont gardés.
 */
async function rattacherPatientesDuSecteur(recoOuId, par) {
  const reco = await Reco.findById(recoOuId._id ?? recoOuId).select('+zonesNormalisees');
  if (reco?.statut !== 'Actif') return 0;
  const patientes = await Patiente.find({
    etablissementId: reco.etablissementId, recoId: { $ne: reco._id }, ...SUIVIES,
    $or: [{ recoId: null }, { 'recoAffectation.mode': { $ne: 'Manuelle' } }],
  });
  const actuels = new Map((await Reco.find({ _id: { $in: patientes.map((p) => p.recoId).filter(Boolean) } }).select('+zonesNormalisees'))
    .map((x) => [x.id, x]));
  let n = 0;
  for (const p of patientes) {
    const actuel = p.recoId ? actuels.get(String(p.recoId)) : null;
    const niveauActuel = actuel?.statut === 'Actif' && actuel.etablissementId === p.etablissementId ? niveau(actuel, p.adresse) : Infinity;
    if (niveau(reco, p.adresse) >= niveauActuel) continue;
    const changement = placer(p, reco, par, 'Automatique');
    await p.save();
    await prevenir(p, changement);
    n += 1;
  }
  return n;
}

module.exports = {
  choisirRecoPatiente, recoDesigne, placer, prevenir, affecterAutomatiquement, reaffecterPatientesDe, rattacherPatientesDuSecteur, nomPatiente,
};
