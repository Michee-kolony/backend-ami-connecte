// Espace du comité de pilotage (propriétaire du projet) : enregistrement des établissements
// sanitaires et de leur médecin chef, et indicateurs consolidés de tous les établissements.
// Le comité ne voit que des agrégats : aucun nom, téléphone ni lien vers un dossier de patiente.
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const MembreComite = require('../models/MembreComite');
const Etablissement = require('../models/Etablissement');
const Soignant = require('../models/Soignant');
const Patiente = require('../models/Patiente');
const Grossesse = require('../models/Grossesse');
const Consultation = require('../models/Consultation');
const Accouchement = require('../models/Accouchement');
const Enfant = require('../models/Enfant');
const Urgence = require('../models/Urgence');
const etab = require('./etablissements');
const { motDePasseValide, genererMotDePasse } = require('./soignants');
const { messageValidation } = require('../config/erreursFr');
const { supprimerFichier } = require('../config/r2');
const presence = require('../config/presence');

const ROLE_CHEF = 'Médecin chef de service';
const MESSAGE_MDP = 'Mot de passe trop faible (10 caractères, majuscules, minuscules, chiffre et caractère spécial).';

// --- Compte du membre ---------------------------------------------------------------------

exports.connexion = async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const motDePasse = String(req.body.motDePasse || '');
  if (!email || !motDePasse) return res.status(400).json({ message: 'E-mail et mot de passe requis.' });
  const membre = await MembreComite.findOne({ email }).select('+motDePasse');
  // Même message dans tous les cas pour ne pas révéler quels e-mails existent.
  if (!membre || !(await bcrypt.compare(motDePasse, membre.motDePasse))) {
    return res.status(401).json({ message: 'E-mail ou mot de passe incorrect.' });
  }
  if (membre.statut !== 'Actif') return res.status(403).json({ message: 'Ce compte est suspendu.' });
  membre.derniereConnexion = new Date();
  await membre.save();
  const jeton = jwt.sign({ sub: membre.id, typ: 'comite' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
  res.json({ jeton, membre });
};

exports.moi = (req, res) => res.json(req.membreComite);

exports.changerMotDePasse = async (req, res) => {
  const membre = await MembreComite.findById(req.membreComite._id).select('+motDePasse');
  if (!(await bcrypt.compare(String(req.body.actuel || ''), membre.motDePasse))) {
    return res.status(400).json({ message: 'Mot de passe actuel incorrect.' });
  }
  const nouveau = String(req.body.nouveau || '');
  if (!motDePasseValide(nouveau)) return res.status(400).json({ message: MESSAGE_MDP });
  membre.motDePasse = await bcrypt.hash(nouveau, 12);
  membre.doitChangerMotDePasse = false;
  await membre.save();
  res.json(membre);
};

// --- Médecin chef --------------------------------------------------------------------------

/** Champs d'identité du médecin chef acceptés depuis le formulaire (liste blanche). */
const CHAMPS_CHEF = [
  'prenom', 'nom', 'postnom', 'sexe', 'dateNaissance', 'lieuNaissance', 'nationalite',
  'pieceType', 'pieceNumero', 'adresse', 'telephone', 'numeroOrdre', 'grade', 'specialite',
];

/** Lit le médecin chef envoyé (objet JSON ou chaîne JSON d'un formulaire multipart). */
function lireChef(brut) {
  if (brut == null || brut === '') return null;
  try {
    return typeof brut === 'string' ? JSON.parse(brut) : brut;
  } catch {
    return undefined;
  }
}

/**
 * Prépare (sans l'enregistrer) le compte du médecin chef d'un établissement, avec un mot de passe
 * temporaire généré : il est renvoyé une seule fois, à remettre en personne, et doit être changé
 * à la première connexion. Lève une erreur 400/409 si les données sont invalides.
 */
async function preparerChef(d, etablissementId, membre) {
  const email = String(d.email || '').trim().toLowerCase();
  if (!email) throw Object.assign(new Error('L’e-mail du médecin chef est obligatoire.'), { status: 400 });
  if (await Soignant.exists({ email })) throw Object.assign(new Error('Cet e-mail est déjà utilisé par un autre soignant.'), { status: 409 });
  const numeroOrdre = String(d.numeroOrdre || '').trim().toUpperCase();
  if (numeroOrdre && await Soignant.exists({ numeroOrdre })) {
    throw Object.assign(new Error('Ce numéro d’Ordre est déjà enregistré.'), { status: 409 });
  }
  const motDePasse = genererMotDePasse();
  const champs = {};
  for (const c of CHAMPS_CHEF) if (d[c] !== undefined) champs[c] = typeof d[c] === 'string' ? d[c].trim() : d[c];
  const chef = new Soignant({
    ...champs,
    numeroOrdre,
    matricule: await Soignant.prochainMatricule(ROLE_CHEF),
    role: ROLE_CHEF,
    email,
    motDePasse: await bcrypt.hash(motDePasse, 12),
    affectations: [{ etablissementId: String(etablissementId), service: 'Direction' }],
    doitChangerMotDePasse: true,
    auteurAjout: membre.instantane(),
  });
  try {
    await chef.validate();
  } catch (err) {
    throw Object.assign(new Error(`Médecin chef : ${messageValidation(err)}`), { status: 400 });
  }
  return { chef, motDePasse };
}

/** Résumé du médecin chef affiché au comité (jamais de mot de passe). */
const resumeChef = (s) => ({
  id: s.id, matricule: s.matricule, prenom: s.prenom, nom: s.nom, postnom: s.postnom,
  email: s.email, telephone: s.telephone, photo: s.photo ?? null, statut: s.statut,
  derniereConnexion: s.derniereConnexion, doitChangerMotDePasse: s.doitChangerMotDePasse,
});

// --- Établissements ------------------------------------------------------------------------

/** Liste des établissements avec leur médecin chef et leurs effectifs (soignants, patientes). */
exports.listerEtablissements = async (req, res) => {
  const [etablissements, soignants, patientes] = await Promise.all([
    Etablissement.find().sort({ createdAt: -1 }),
    Soignant.find().select('matricule prenom nom postnom email telephone photo statut role affectations derniereConnexion doitChangerMotDePasse'),
    Patiente.aggregate([{ $group: { _id: '$etablissementId', n: { $sum: 1 } } }]),
  ]);
  const nbPatientes = new Map(patientes.map((p) => [p._id, p.n]));
  res.json(etablissements.map((e) => {
    const personnel = soignants.filter((s) => s.affectations.some((a) => a.etablissementId === e.id));
    return {
      ...e.toJSON(),
      medecinsChefs: personnel.filter((s) => s.role === ROLE_CHEF).map(resumeChef),
      effectifs: { soignants: personnel.length, patientes: nbPatientes.get(e.id) ?? 0 },
    };
  }));
};

/**
 * Enregistre un établissement et son médecin chef en une fois (formulaire multipart : champs de
 * l'établissement, photos, et `medecinChef` en JSON). Rien n'est gardé si l'un des deux échoue.
 */
exports.creerEtablissement = async (req, res) => {
  const fichiers = req.files || [];
  if (fichiers.length > etab.MAX_PHOTOS) return res.status(400).json({ message: `${etab.MAX_PHOTOS} photos au maximum.` });
  const donneesChef = lireChef(req.body.medecinChef);
  if (!donneesChef) return res.status(400).json({ message: 'Les informations du médecin chef sont obligatoires.' });

  const e = new Etablissement({ creeParComite: req.membreComite._id });
  try {
    etab.appliquer(e, req.body);
  } catch {
    return res.status(400).json({ message: 'Services invalides.' });
  }
  if (!e.province) return res.status(400).json({ message: 'La province est obligatoire.' });
  if (await etab.nomDejaPris(e.nom, e.province)) {
    return res.status(409).json({ message: 'Un établissement porte déjà ce nom dans cette province.' });
  }
  e.code = await Etablissement.prochainCode(e.province);
  try {
    await e.validate();
  } catch (err) {
    return res.status(400).json({ message: messageValidation(err) });
  }
  // Le compte du médecin chef est vérifié avant tout envoi ou enregistrement.
  let chef;
  let motDePasse;
  try {
    ({ chef, motDePasse } = await preparerChef(donneesChef, e._id, req.membreComite));
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
  }

  e.photos = await etab.envoyerPhotos(fichiers);
  try {
    await e.save();
  } catch (err) {
    await etab.supprimerPhotos(e.photos);
    if (err.code === 11000) return res.status(409).json({ message: 'Code déjà attribué, réessayez.' });
    throw err;
  }
  try {
    await chef.save();
  } catch (err) {
    // Pas d'établissement sans médecin chef : l'enregistrement est annulé.
    await e.deleteOne();
    await etab.supprimerPhotos(e.photos);
    if (err.code === 11000) return res.status(409).json({ message: 'Ce médecin existe déjà (e-mail, matricule ou numéro d’Ordre).' });
    throw err;
  }
  res.status(201).json({ etablissement: e, medecinChef: resumeChef(chef), motDePasseTemporaire: motDePasse });
};

/** Désigne le médecin chef d'un établissement qui n'en a pas (établissements enregistrés avant le comité). */
exports.designerMedecinChef = async (req, res) => {
  const e = mongoose.isValidObjectId(req.params.id) && await Etablissement.findById(req.params.id);
  if (!e) return res.status(404).json({ message: 'Établissement introuvable.' });
  const actif = await Soignant.exists({ role: ROLE_CHEF, statut: 'Actif', 'affectations.etablissementId': e.id });
  if (actif) return res.status(409).json({ message: 'Cet établissement a déjà un médecin chef actif.' });
  const donnees = lireChef(req.body.medecinChef ?? req.body);
  if (!donnees) return res.status(400).json({ message: 'Les informations du médecin chef sont obligatoires.' });
  let chef;
  let motDePasse;
  try {
    ({ chef, motDePasse } = await preparerChef(donnees, e._id, req.membreComite));
  } catch (err) {
    return res.status(err.status || 400).json({ message: err.message });
  }
  try {
    await chef.save();
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Ce médecin existe déjà (e-mail, matricule ou numéro d’Ordre).' });
    throw err;
  }
  res.status(201).json({ medecinChef: resumeChef(chef), motDePasseTemporaire: motDePasse });
};

/** Médecin chef de cet établissement (404 sinon). */
async function chefDe(req) {
  const e = mongoose.isValidObjectId(req.params.id) && await Etablissement.findById(req.params.id);
  const chef = e && mongoose.isValidObjectId(req.params.chefId)
    && await Soignant.findOne({ _id: req.params.chefId, role: ROLE_CHEF, 'affectations.etablissementId': e.id });
  if (!chef) throw Object.assign(new Error('Médecin chef introuvable pour cet établissement.'), { status: 404 });
  return chef;
}

/** Suspend ou réactive le compte d'un médecin chef. */
exports.basculerMedecinChef = async (req, res) => {
  const chef = await chefDe(req);
  chef.statut = chef.statut === 'Actif' ? 'Suspendu' : 'Actif';
  await chef.save();
  if (chef.statut === 'Suspendu') presence.expulser(chef.id);
  res.json(resumeChef(chef));
};

/** Nouveau mot de passe temporaire du médecin chef, renvoyé une seule fois. */
exports.reinitialiserMedecinChef = async (req, res) => {
  const chef = await chefDe(req);
  const motDePasse = genererMotDePasse();
  chef.motDePasse = await bcrypt.hash(motDePasse, 12);
  chef.doitChangerMotDePasse = true;
  await chef.save();
  res.json({ medecinChef: resumeChef(chef), motDePasseTemporaire: motDePasse });
};

/**
 * Suppression d'un établissement : refusée tant que du personnel (autre que son médecin chef) y
 * est rattaché. Le compte du médecin chef qui n'exerce que là est supprimé avec lui.
 */
exports.supprimerEtablissement = async (req, res) => {
  const e = mongoose.isValidObjectId(req.params.id) && await Etablissement.findById(req.params.id);
  if (!e) return res.status(404).json({ message: 'Établissement introuvable.' });
  const rattaches = await Soignant.find({ 'affectations.etablissementId': e.id }).select('+photoCle');
  const chefsSeuls = rattaches.filter((s) => s.role === ROLE_CHEF && s.affectations.length === 1);
  const autres = rattaches.length - chefsSeuls.length;
  if (autres) {
    return res.status(409).json({
      message: `${autres} soignant(s) sont encore rattachés à cet établissement. Le médecin chef doit d’abord les retirer, ou suspendez l’établissement à la place.`,
    });
  }
  if (await Patiente.exists({ etablissementId: e.id })) {
    return res.status(409).json({ message: 'Des patientes sont enregistrées dans cet établissement : suspendez-le plutôt que de le supprimer.' });
  }
  for (const chef of chefsSeuls) {
    await chef.deleteOne();
    presence.expulser(chef.id);
    if (chef.photoCle) await supprimerFichier(chef.photoCle).catch(() => {});
  }
  await e.deleteOne();
  await etab.supprimerPhotos(e.photos);
  res.status(204).end();
};

// --- Indicateurs consolidés ---------------------------------------------------------------

/** Clés des listes nominatives (patientes, enfants, tâches) retirées des réponses du comité. */
const LISTES_NOMINATIVES = new Set(['recentes', 'prochainsRdv', 'aRattraper', 'lignes']);

/**
 * Retire d'une réponse de statistiques tout ce qui désigne une personne (noms, numéros,
 * téléphones) et les liens vers les pages du personnel. Les agrégats restent intacts.
 */
function anonymiser(valeur, cle = '') {
  if (Array.isArray(valeur)) return valeur.map((v) => anonymiser(v));
  if (!valeur || typeof valeur !== 'object' || valeur instanceof Date) return valeur;
  const sortie = {};
  for (const [k, v] of Object.entries(valeur)) {
    if (k === 'lien' || k === 'requete' || k === 'personne' || k === 'patiente' || k === 'telephone') continue;
    // « lignes » des analyses mensuelles sont des agrégats ; seule la liste « à traiter » est nominative.
    if (LISTES_NOMINATIVES.has(k) && (k !== 'lignes' || cle === 'aTraiter')) {
      sortie[k] = [];
      continue;
    }
    sortie[k] = anonymiser(v, k);
  }
  return sortie;
}

/** Exécute un contrôleur de statistiques existant et anonymise sa réponse pour le comité. */
exports.statistiques = (controleur) => async (req, res, next) => {
  const json = res.json.bind(res);
  res.json = (corps) => json(res.statusCode < 400 ? anonymiser(corps) : corps);
  return controleur(req, res, next);
};

/** Totaux enregistrés par chaque établissement (tableau comparatif du comité). */
exports.parEtablissement = async (req, res) => {
  const compter = (Modele, filtre = {}) => Modele.aggregate([{ $match: filtre }, { $group: { _id: '$etablissementId', n: { $sum: 1 } } }])
    .then((l) => new Map(l.map((x) => [x._id, x.n])));
  const [etablissements, soignants, patientes, consultations, accouchements, enfants, urgences, grossesses, patientesEtab] = await Promise.all([
    Etablissement.find().sort({ nom: 1 }),
    Soignant.find({ statut: 'Actif' }).select('affectations role').lean(),
    compter(Patiente),
    compter(Consultation, { statut: 'Finalisée' }),
    compter(Accouchement),
    compter(Enfant),
    compter(Urgence),
    Grossesse.find({ statut: 'En cours' }).select('patienteId').lean(),
    Patiente.find().select('etablissementId').lean(),
  ]);
  // Grossesses en cours : rattachées à l'établissement de la patiente.
  const etabDe = new Map(patientesEtab.map((p) => [String(p._id), p.etablissementId]));
  const enCours = new Map();
  for (const g of grossesses) {
    const id = etabDe.get(String(g.patienteId));
    if (id) enCours.set(id, (enCours.get(id) ?? 0) + 1);
  }
  const lignes = etablissements.map((e) => {
    const personnel = soignants.filter((s) => s.affectations.some((a) => a.etablissementId === e.id));
    return {
      id: e.id, code: e.code, nom: e.nom, type: e.type, province: e.province, statut: e.statut,
      soignants: personnel.length,
      medecinChef: personnel.some((s) => s.role === ROLE_CHEF),
      patientes: patientes.get(e.id) ?? 0,
      grossessesEnCours: enCours.get(e.id) ?? 0,
      consultations: consultations.get(e.id) ?? 0,
      accouchements: accouchements.get(e.id) ?? 0,
      enfants: enfants.get(e.id) ?? 0,
      urgences: urgences.get(e.id) ?? 0,
    };
  });
  const somme = (k) => lignes.reduce((s, l) => s + l[k], 0);
  res.json({
    genereLe: new Date(),
    totaux: {
      etablissements: lignes.length,
      actifs: lignes.filter((l) => l.statut === 'Actif').length,
      provinces: new Set(lignes.map((l) => l.province)).size,
      sansMedecinChef: lignes.filter((l) => !l.medecinChef).length,
      // Un soignant qui exerce dans plusieurs établissements n'est compté qu'une fois.
      soignants: soignants.filter((s) => s.affectations.some((a) => lignes.some((l) => l.id === a.etablissementId))).length,
      ...Object.fromEntries(['patientes', 'grossessesEnCours', 'consultations', 'accouchements', 'enfants', 'urgences'].map((k) => [k, somme(k)])),
    },
    etablissements: lignes,
  });
};
