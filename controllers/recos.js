// Comptes des relais communautaires (RECO) : gérés par les superviseurs et responsables de
// structure. Révocation rapide d'un téléphone perdu ou compromis (section 14).
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Reco = require('../models/Reco');
const Soignant = require('../models/Soignant');
const TacheRelance = require('../models/TacheRelance');
const AlerteRelance = require('../models/AlerteRelance');
const Etablissement = require('../models/Etablissement');
const { auteurDe, enregistrerAvecMatricule } = require('../models/commun');
const { journaliser } = require('../config/audit');
const { ROLES_RESPONSABLE } = require('../config/relance');
const moteur = require('../config/moteurRelance');
const { envoyerFichier, supprimerFichier } = require('../config/r2');
const { motDePasseValide, genererMotDePasse, donneesDe } = require('./flotte');
const { exigerSupervision, filtreTerritoire } = require('./relance');
const { erreur, texte, valider } = require('./saisie');

async function trouverReco(req, id) {
  const reco = mongoose.isValidObjectId(id) ? await Reco.findOne({ _id: id, ...filtreTerritoire(req) }) : null;
  if (!reco) throw erreur(404, 'RECO introuvable.');
  return reco;
}

/** RECO avec leur charge active (tâches ouvertes, en retard). */
async function vues(liste) {
  const charge = await TacheRelance.aggregate([
    { $match: { recoId: { $in: liste.map((x) => x._id) }, ouverte: true } },
    { $group: { _id: '$recoId', ouvertes: { $sum: 1 }, enRetard: { $sum: { $cond: [{ $lt: ['$echeance', new Date()] }, 1, 0] } } } },
  ]);
  const parReco = new Map(charge.map((c) => [String(c._id), c]));
  return liste.map((x) => ({ ...x.toJSON(), ouvertes: parReco.get(x.id)?.ouvertes ?? 0, enRetard: parReco.get(x.id)?.enRetard ?? 0 }));
}

/** Champs modifiables du compte. */
async function lireChamps(req, d, { creation }) {
  const c = {};
  for (const k of ['prenom', 'nom', 'postnom', 'telephone', 'aireSante']) if (d[k] !== undefined) c[k] = texte(d[k], 120);
  if (d.sexe !== undefined) c.sexe = ['F', 'M'].includes(d.sexe) ? d.sexe : '';
  if (d.zones !== undefined) {
    const zones = Array.isArray(d.zones) ? d.zones : String(d.zones).split(/[,;\n]/);
    c.zones = zones.map((z) => texte(z, 120)).filter(Boolean).slice(0, 50);
  }
  if (d.etablissementId !== undefined || creation) {
    const etablissementId = String(d.etablissementId || req.etablissementId || '');
    if (req.etablissementId && etablissementId !== req.etablissementId) throw erreur(403, 'Vous ne gérez que les RECO de votre structure.');
    const [etab] = await Etablissement.actifsParIds([etablissementId]);
    if (!etab) throw erreur(400, 'Choisissez la structure de rattachement du RECO.');
    c.etablissementId = etab.id;
    if (!c.aireSante && !d.aireSante) c.aireSante = etab.aireSante;
  }
  if (d.superviseurId !== undefined) {
    if (!d.superviseurId) c.superviseurId = null;
    else {
      const sup = mongoose.isValidObjectId(d.superviseurId) ? await Soignant.findById(d.superviseurId).select('statut') : null;
      if (!sup || sup.statut !== 'Actif') throw erreur(400, 'Superviseur introuvable.');
      c.superviseurId = sup._id;
    }
  }
  return c;
}

exports.lister = async (req, res) => {
  const liste = await Reco.find(filtreTerritoire(req)).sort({ statut: 1, nom: 1 });
  res.json(await vues(liste));
};

/**
 * Création du compte : formulaire multipart, données JSON dans « donnees », photo de profil
 * (obligatoire : le RECO est reconnu par les familles et le superviseur) dans « photo ».
 */
exports.creer = async (req, res) => {
  await exigerSupervision(req);
  if (!req.file) throw erreur(400, 'La photo de profil du RECO est obligatoire.');
  const d = donneesDe(req);
  const champs = await lireChamps(req, d, { creation: true });
  // Mot de passe choisi (règle de l'espace administrateur), sinon temporaire généré.
  const motDePasse = d.motDePasse ? String(d.motDePasse) : genererMotDePasse();
  if (!motDePasseValide(motDePasse)) throw erreur(400, 'Mot de passe trop faible (10 caractères, majuscules, minuscules, chiffre et caractère spécial).');
  const reco = new Reco({
    ...champs, matricule: 'RECO-000000', motDePasse: await bcrypt.hash(motDePasse, 12),
    // Mot de passe temporaire généré : toujours à changer ; choisi par l'admin : selon son choix.
    doitChangerMotDePasse: !d.motDePasse || (d.doitChangerMotDePasse !== false && d.doitChangerMotDePasse !== 'false'),
    creePar: auteurDe(req.soignant),
  });
  await valider(reco);
  const { cle, url } = await envoyerFichier(req.file, 'recos');
  reco.photo = url;
  reco.photoCle = cle;
  // Matricule (identifiant de connexion) attribué au hasard par le serveur, jamais saisi.
  await enregistrerAvecMatricule(reco, 'RECO');
  await journaliser(req, { action: 'reco.creation', ressource: { type: 'reco', id: reco.matricule } });
  const [vue] = await vues([reco]);
  // Le mot de passe n'est renvoyé qu'une fois, pour être remis au RECO en personne.
  res.status(201).json({ reco: vue, motDePasse: d.motDePasse ? null : motDePasse });
};

exports.modifier = async (req, res) => {
  await exigerSupervision(req);
  const reco = await trouverReco(req, req.params.id);
  const d = donneesDe(req);
  Object.assign(reco, await lireChamps(req, d, { creation: false }), { modifiePar: auteurDe(req.soignant) });
  await valider(reco);
  // Photo remplacée : l'ancienne est supprimée de R2 une fois la nouvelle enregistrée.
  const anciennePhoto = req.file ? reco.photoCle : null;
  if (req.file) {
    const { cle, url } = await envoyerFichier(req.file, 'recos');
    reco.photo = url;
    reco.photoCle = cle;
  }
  await reco.save();
  if (anciennePhoto) supprimerFichier(anciennePhoto).catch(() => {});
  await journaliser(req, { action: 'reco.modification', ressource: { type: 'reco', id: reco.matricule }, details: { champs: Object.keys(d), photo: !!req.file } });
  const [vue] = await vues([reco]);
  res.json(vue);
};

/** Suspension (révoque aussitôt les sessions) ou réactivation. */
exports.changerStatut = async (req, res) => {
  await exigerSupervision(req);
  const reco = await trouverReco(req, req.params.id);
  const statut = req.body?.statut;
  if (!['Actif', 'Suspendu'].includes(statut)) throw erreur(400, 'Statut invalide.');
  reco.statut = statut;
  if (statut === 'Suspendu') reco.sessionsRevoqueesLe = new Date(Math.floor(Date.now() / 1000) * 1000);
  reco.modifiePar = auteurDe(req.soignant);
  await reco.save();
  // Ses tâches ouvertes doivent être réattribuées : le superviseur est alerté.
  if (statut === 'Suspendu') {
    const taches = await TacheRelance.find({ recoId: reco._id, ouverte: true }).select('numero etablissementId');
    if (taches.length) await moteur.alerter('non_attribuee', { etablissementId: reco.etablissementId, taches: taches.map((t) => t.numero) });
  }
  await journaliser(req, { action: 'reco.statut', ressource: { type: 'reco', id: reco.matricule }, details: { statut } });
  const [vue] = await vues([reco]);
  res.json(vue);
};

/** Téléphone perdu ou compromis : toutes les sessions ouvertes sont refusées dès maintenant. */
exports.revoquerSessions = async (req, res) => {
  await exigerSupervision(req);
  const reco = await trouverReco(req, req.params.id);
  reco.sessionsRevoqueesLe = new Date(Math.floor(Date.now() / 1000) * 1000);
  await reco.save();
  await journaliser(req, { action: 'reco.revocation', ressource: { type: 'reco', id: reco.matricule } });
  res.json({ revoqueesLe: reco.sessionsRevoqueesLe });
};

/** Nouveau mot de passe temporaire, à remettre en personne ; les sessions en cours sont révoquées. */
exports.reinitialiserMotDePasse = async (req, res) => {
  await exigerSupervision(req);
  const reco = await trouverReco(req, req.params.id);
  const motDePasse = genererMotDePasse();
  reco.motDePasse = await bcrypt.hash(motDePasse, 12);
  reco.doitChangerMotDePasse = true;
  reco.sessionsRevoqueesLe = new Date(Math.floor(Date.now() / 1000) * 1000);
  await reco.save();
  await journaliser(req, { action: 'reco.mot_de_passe', ressource: { type: 'reco', id: reco.matricule } });
  res.json({ matricule: reco.matricule, motDePasse });
};

/**
 * Suppression définitive du compte (droits dans config/relance.js). Refusée tant que le
 * RECO a des tâches ouvertes : elles doivent d'abord être réattribuées, pour qu'aucune personne
 * ne reste sans suivi. Les tâches traitées gardent leur historique (auteurs figés à l'action).
 */
exports.supprimer = async (req, res) => {
  if (!ROLES_RESPONSABLE.includes(req.soignant.role)) {
    await journaliser(req, { action: 'acces.refuse', resultat: 'refusé', ressource: { type: 'reco', id: req.params.id }, details: { role: req.soignant.role } });
    throw erreur(403, 'La suppression d’un RECO est réservée au médecin chef de service et au médecin directeur. Vous pouvez le suspendre.');
  }
  const reco = await trouverReco(req, req.params.id);
  const ouvertes = await TacheRelance.countDocuments({ recoId: reco._id, ouverte: true });
  if (ouvertes) throw erreur(409, `${reco.prenom} ${reco.nom} a encore ${ouvertes} tâche(s) ouverte(s) : réattribuez-les avant de supprimer le compte.`);
  await Reco.deleteOne({ _id: reco._id });
  // Ses alertes ne concernaient que lui : fermées (conservées pour l'historique).
  await AlerteRelance.updateMany({ destinataire: 'reco', recoId: reco._id, ouverte: true }, { ouverte: false, accuseLe: new Date(), accusePar: auteurDe(req.soignant) });
  if (reco.photoCle) supprimerFichier(reco.photoCle).catch(() => {});
  await journaliser(req, {
    action: 'reco.suppression', ressource: { type: 'reco', id: reco.matricule },
    details: { nom: `${reco.prenom} ${reco.nom}`, etablissementId: reco.etablissementId },
  });
  res.json({ id: reco.id, matricule: reco.matricule, supprime: true });
};
