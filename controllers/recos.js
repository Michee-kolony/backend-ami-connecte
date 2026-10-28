// Comptes des relais communautaires (RECO) : gérés par les superviseurs et responsables de
// structure. Révocation rapide d'un téléphone perdu ou compromis (section 14).
const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Reco = require('../models/Reco');
const Soignant = require('../models/Soignant');
const TacheRelance = require('../models/TacheRelance');
const Etablissement = require('../models/Etablissement');
const { auteurDe } = require('../models/commun');
const { journaliser } = require('../config/audit');
const moteur = require('../config/moteurRelance');
const { motDePasseValide, genererMotDePasse } = require('./flotte');
const { exigerSupervision, filtreTerritoire } = require('./relance');
const { erreur, texte, objet, valider } = require('./saisie');

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

exports.prochainMatricule = async (req, res) => {
  res.json({ matricule: await Reco.prochainMatricule() });
};

exports.creer = async (req, res) => {
  await exigerSupervision(req);
  const d = objet(req.body);
  const champs = await lireChamps(req, d, { creation: true });
  // Mot de passe choisi (règle de l'espace administrateur), sinon temporaire généré.
  const motDePasse = d.motDePasse ? String(d.motDePasse) : genererMotDePasse();
  if (!motDePasseValide(motDePasse)) throw erreur(400, 'Mot de passe trop faible (10 caractères, majuscules, minuscules, chiffre et caractère spécial).');
  const matricule = texte(d.matricule, 20).toUpperCase() || await Reco.prochainMatricule();
  if (!/^RECO-\d{4,}$/.test(matricule)) throw erreur(400, 'Matricule invalide (RECO-0001).');
  if (await Reco.exists({ matricule })) throw erreur(409, 'Ce matricule est déjà utilisé.');
  const reco = new Reco({
    ...champs, matricule, motDePasse: await bcrypt.hash(motDePasse, 12), doitChangerMotDePasse: true, creePar: auteurDe(req.soignant),
  });
  await valider(reco);
  await reco.save();
  await journaliser(req, { action: 'reco.creation', ressource: { type: 'reco', id: reco.matricule } });
  const [vue] = await vues([reco]);
  // Le mot de passe n'est renvoyé qu'une fois, pour être remis au RECO en personne.
  res.status(201).json({ reco: vue, motDePasse: d.motDePasse ? null : motDePasse });
};

exports.modifier = async (req, res) => {
  await exigerSupervision(req);
  const reco = await trouverReco(req, req.params.id);
  Object.assign(reco, await lireChamps(req, objet(req.body), { creation: false }), { modifiePar: auteurDe(req.soignant) });
  await valider(reco);
  await reco.save();
  await journaliser(req, { action: 'reco.modification', ressource: { type: 'reco', id: reco.matricule } });
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
