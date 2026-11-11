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
const { envoyerFichier, supprimerFichier } = require('../config/r2');
const presence = require('../config/presence');
const { PROVINCES_RDC } = require('../config/referentiels');
const { zonesDeProvince } = require('../config/zonesSante');

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

/** Champs que chaque membre renseigne lui-même dans son profil (ni e-mail, ni statut). */
const CHAMPS_PROFIL_COMITE = ['prenom', 'nom', 'sexe', 'fonction', 'organisation', 'telephone'];

/** Profil du membre connecté, avec une nouvelle photo facultative (multipart, champ « photo »). */
exports.modifierProfil = async (req, res) => {
  const membre = await MembreComite.findById(req.membreComite._id).select('+photoCle');
  for (const c of CHAMPS_PROFIL_COMITE) {
    if (req.body[c] !== undefined) membre[c] = String(req.body[c]).trim();
  }
  try {
    await membre.validate();
  } catch (err) {
    return res.status(400).json({ message: messageValidation(err) });
  }
  const ancienneCle = membre.photoCle;
  if (req.file) {
    const { cle, url } = await envoyerFichier(req.file, 'comite');
    membre.photo = url;
    membre.photoCle = cle;
  } else if (req.body.retirerPhoto === 'true') {
    membre.photo = null;
    membre.photoCle = null;
  }
  await membre.save();
  // L'ancienne photo quitte le stockage une fois la nouvelle enregistrée.
  if (ancienneCle && ancienneCle !== membre.photoCle) await supprimerFichier(ancienneCle).catch(() => {});
  res.json(membre);
};

// --- Membres du comité ---------------------------------------------------------------------

/**
 * Retrait d'un membre du comité : réservé au président, qui ne peut pas se retirer lui-même.
 * Le compte et sa photo sont supprimés ; ses sessions ouvertes sont refusées aussitôt.
 */
exports.supprimerMembre = async (req, res) => {
  if (!req.membreComite.estPresident) {
    return res.status(403).json({ message: 'Seul le président du comité peut retirer un membre.' });
  }
  const membre = mongoose.isValidObjectId(req.params.id) && await MembreComite.findById(req.params.id).select('+photoCle');
  if (!membre) return res.status(404).json({ message: 'Membre du comité introuvable.' });
  if (membre.id === req.membreComite.id) {
    return res.status(400).json({ message: 'Vous ne pouvez pas retirer votre propre compte.' });
  }
  await membre.deleteOne();
  presence.expulserComite(membre.id);
  if (membre.photoCle) await supprimerFichier(membre.photoCle).catch(() => {});
  res.status(204).end();
};

exports.listerMembres = async (req, res) => {
  res.json(await MembreComite.find().sort({ nom: 1, prenom: 1 }));
};

/**
 * Un membre du comité en ajoute un autre. Un mot de passe temporaire est généré : il est renvoyé
 * une seule fois, à remettre au nouveau membre, qui le change à sa première connexion.
 */
exports.ajouterMembre = async (req, res) => {
  const d = req.body || {};
  const email = String(d.email || '').trim().toLowerCase();
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ message: 'Adresse e-mail invalide.' });
  if (await MembreComite.exists({ email })) return res.status(409).json({ message: 'Un membre du comité utilise déjà cet e-mail.' });
  const motDePasse = genererMotDePasse();
  const membre = new MembreComite({
    email,
    motDePasse: await bcrypt.hash(motDePasse, 12),
    doitChangerMotDePasse: true,
    creePar: req.membreComite._id,
    ajoutePar: { nom: `${req.membreComite.prenom} ${req.membreComite.nom}` },
  });
  for (const c of CHAMPS_PROFIL_COMITE) if (d[c] !== undefined) membre[c] = String(d[c]).trim();
  try {
    await membre.save();
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ message: 'Un membre du comité utilise déjà cet e-mail.' });
    return res.status(400).json({ message: messageValidation(err) });
  }
  res.status(201).json({ membre, motDePasseTemporaire: motDePasse });
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
    return res.status(400).json({ message: 'Services ou zones de santé invalides.' });
  }
  if (!e.province) return res.status(400).json({ message: 'La province est obligatoire.' });
  const erreurZones = e.erreurZones();
  if (erreurZones) return res.status(400).json({ message: erreurZones });
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

// --- Personnel soignant (lecture seule) ---------------------------------------------------

/** Champs professionnels montrés au comité (ni pièce d'identité, ni date de naissance, ni adresse). */
const CHAMPS_PERSONNEL = 'matricule prenom nom postnom sexe photo numeroOrdre grade specialite affectations email telephone role statut derniereConnexion doitChangerMotDePasse createdAt auteurAjout creePar';

/**
 * Tout le personnel soignant de la plateforme, avec le ou les établissements où chacun est
 * affecté (le premier est l'établissement principal). Lecture seule : les comptes sont gérés par
 * le médecin chef de chaque établissement.
 */
exports.listerSoignants = async (req, res) => {
  const [soignants, etablissements] = await Promise.all([
    Soignant.find().select(CHAMPS_PERSONNEL).sort({ nom: 1, prenom: 1 }).populate('creePar', Soignant.CHAMPS_AUTEUR),
    Etablissement.find().select('code nom province type statut'),
  ]);
  const etab = new Map(etablissements.map((e) => [e.id, e]));
  res.json(soignants.map((s) => {
    const j = s.toJSON();
    return {
      id: j.id, matricule: j.matricule, prenom: j.prenom, nom: j.nom, postnom: j.postnom, sexe: j.sexe,
      photo: j.photo ?? null, numeroOrdre: j.numeroOrdre ?? '', grade: j.grade, specialite: j.specialite,
      email: j.email, telephone: j.telephone, role: j.role, statut: j.statut,
      derniereConnexion: j.derniereConnexion, doitChangerMotDePasse: j.doitChangerMotDePasse,
      creeLe: j.createdAt, ajoutePar: j.ajoutePar ? { nom: j.ajoutePar.nom, role: j.ajoutePar.role } : null,
      affectations: j.affectations.map((a) => {
        const e = etab.get(a.etablissementId);
        return {
          etablissementId: a.etablissementId, service: a.service,
          code: e?.code ?? '', nom: e?.nom ?? 'Établissement supprimé', province: e?.province ?? '', type: e?.type ?? '', statut: e?.statut ?? null,
        };
      }),
    };
  }));
};

// --- Patientes : identité et enfants seulement --------------------------------------------

const PATIENTES_PAR_PAGE = 30;
const echapper = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Âge en années révolues à partir d'une date AAAA-MM-JJ (ou de l'âge déclaré). */
function ageDe(dateNaissance, ageDeclare) {
  if (!dateNaissance) return ageDeclare ?? null;
  const [a, m, j] = String(dateNaissance).split('-').map(Number);
  const auj = new Date();
  let age = auj.getFullYear() - a;
  if (auj.getMonth() + 1 < m || (auj.getMonth() + 1 === m && auj.getDate() < j)) age--;
  return age;
}

/**
 * Toutes les patientes de la plateforme, pour le comité : identité seulement (numéro AMI, noms,
 * âge, lieu de résidence, établissement de suivi, date d'inscription) et leurs enfants (identité).
 * Aucune donnée médicale ni coordonnée : ni grossesse, ni consultation, ni téléphone, ni statut
 * de suivi. Recherche ?q (nom ou numéro), filtre ?etablissement, pagination ?page. Consultation
 * inscrite au journal d'audit.
 */
exports.listerPatientes = async (req, res) => {
  const { urlSignee } = require('../config/r2');
  const { journaliser } = require('../config/audit');
  const Enfant = require('../models/Enfant');
  const filtre = {};
  const q = String(req.query.q || '').trim().slice(0, 80);
  if (q) {
    const re = new RegExp(echapper(q), 'i');
    const enfantsTrouves = await Enfant.distinct('mereId', { $or: [{ nom: re }, { prenom: re }, { postnom: re }, { numero: re }] });
    filtre.$or = [{ nom: re }, { prenom: re }, { postnom: re }, { numero: re }, { _id: { $in: enfantsTrouves } }];
  }
  if (req.query.etablissement && mongoose.isValidObjectId(req.query.etablissement)) filtre.etablissementId = String(req.query.etablissement);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);

  const [total, patientes, etablissements, totalEnfants] = await Promise.all([
    Patiente.countDocuments(filtre),
    Patiente.find(filtre).select('numero nom postnom prenom dateNaissance ageDeclare adresse.province adresse.commune adresse.quartier etablissementId photoCle createdAt')
      .sort({ createdAt: -1 }).skip((page - 1) * PATIENTES_PAR_PAGE).limit(PATIENTES_PAR_PAGE).lean(),
    Etablissement.find().select('code nom province').lean(),
    Enfant.countDocuments(),
  ]);
  const enfants = await Enfant.find({ mereId: { $in: patientes.map((p) => p._id) } })
    .select('numero prenom nom postnom sexe dateNaissance mereId').sort({ dateNaissance: 1 }).lean();
  const etab = new Map(etablissements.map((e) => [String(e._id), e]));

  await journaliser(req, { action: 'comite.patientes.consultation', details: { page, recherche: !!q, nombre: patientes.length } });
  res.json({
    total, page, parPage: PATIENTES_PAR_PAGE, pages: Math.max(1, Math.ceil(total / PATIENTES_PAR_PAGE)), totalEnfants,
    etablissements: etablissements.map((e) => ({ id: String(e._id), nom: e.nom })).sort((a, b) => a.nom.localeCompare(b.nom, 'fr')),
    patientes: await Promise.all(patientes.map(async (p) => {
      const e = etab.get(p.etablissementId);
      return {
        id: String(p._id), numero: p.numero, nom: p.nom, postnom: p.postnom, prenom: p.prenom,
        dateNaissance: p.dateNaissance ?? null, age: ageDe(p.dateNaissance, p.ageDeclare),
        photo: p.photoCle ? await urlSignee(p.photoCle).catch(() => null) : null,
        residence: { province: p.adresse?.province ?? '', commune: p.adresse?.commune ?? '', quartier: p.adresse?.quartier ?? '' },
        etablissement: e ? { id: String(e._id), code: e.code, nom: e.nom, province: e.province } : null,
        inscriteLe: p.createdAt,
        enfants: enfants.filter((x) => String(x.mereId) === String(p._id)).map((x) => ({
          numero: x.numero, prenom: x.prenom, nom: x.nom, postnom: x.postnom, sexe: x.sexe,
          dateNaissance: x.dateNaissance ?? null,
        })),
      };
    })),
  });
};

// --- Relais communautaires (lecture seule) -----------------------------------------------

/**
 * Tous les RECO de la plateforme, avec leur structure de rattachement, leur superviseur et leur
 * charge active (tâches ouvertes, en retard). Lecture seule : ils sont gérés par les superviseurs
 * de chaque établissement.
 */
exports.listerRecos = async (req, res) => {
  const { vues } = require('./recos');
  const Reco = require('../models/Reco');
  const recos = await Reco.find().sort({ nom: 1, prenom: 1 });
  const [lignes, etablissements, superviseurs, relances] = await Promise.all([
    vues(recos),
    Etablissement.find().select('code nom province type statut'),
    Soignant.find({ _id: { $in: recos.map((r) => r.superviseurId).filter(Boolean) } }).select('prenom nom role'),
    require('../models/TacheRelance').aggregate([
      { $match: { recoId: { $in: recos.map((r) => r._id) } } },
      { $group: { _id: '$recoId', total: { $sum: 1 }, terminees: { $sum: { $cond: ['$ouverte', 0, 1] } } } },
    ]),
  ]);
  const etab = new Map(etablissements.map((e) => [e.id, e]));
  const sup = new Map(superviseurs.map((s) => [s.id, s]));
  const tot = new Map(relances.map((t) => [String(t._id), t]));
  res.json(lignes.map((r) => {
    const e = etab.get(r.etablissementId);
    const s = r.superviseurId ? sup.get(r.superviseurId) : null;
    return {
      id: r.id, matricule: r.matricule, prenom: r.prenom, nom: r.nom, postnom: r.postnom, sexe: r.sexe,
      telephone: r.telephone, photo: r.photo ?? null, aireSante: r.aireSante, zones: r.zones,
      statut: r.statut, derniereConnexion: r.derniereConnexion, derniereSynchronisation: r.derniereSynchronisation,
      doitChangerMotDePasse: r.doitChangerMotDePasse, creeLe: r.createdAt, ajoutePar: r.creePar ? { nom: r.creePar.nom, role: r.creePar.role } : null,
      etablissement: e ? { id: e.id, code: e.code, nom: e.nom, province: e.province, type: e.type, statut: e.statut } : { id: r.etablissementId, code: '', nom: 'Établissement supprimé', province: '', type: '', statut: null },
      superviseur: s ? { nom: `${s.prenom} ${s.nom}`, role: s.role } : null,
      taches: { ouvertes: r.ouvertes, enRetard: r.enRetard, total: tot.get(r.id)?.total ?? 0, terminees: tot.get(r.id)?.terminees ?? 0 },
    };
  }));
};

// --- Flotte : ambulances et chauffeurs (lecture seule) ------------------------------------

/**
 * Toutes les ambulances et tous les chauffeurs de la plateforme, avec leur établissement, le
 * chauffeur attitré de chaque ambulance et le nombre de missions effectuées. Lecture seule : la
 * flotte est gérée par chaque établissement. La position GPS n'est pas transmise.
 */
exports.listerFlotte = async (req, res) => {
  const Ambulance = require('../models/Ambulance');
  const Chauffeur = require('../models/Chauffeur');
  const [ambulances, chauffeurs, etablissements, missionsAmb, missionsChf] = await Promise.all([
    Ambulance.find().sort({ code: 1 }).lean(),
    Chauffeur.find().sort({ nom: 1, prenom: 1 }),
    Etablissement.find().select('code nom province type statut'),
    Urgence.aggregate([{ $match: { ambulance: { $ne: null } } }, { $group: { _id: '$ambulance', n: { $sum: 1 } } }]),
    Urgence.aggregate([{ $match: { chauffeurId: { $ne: null } } }, { $group: { _id: '$chauffeurId', n: { $sum: 1 } } }]),
  ]);
  const etab = new Map(etablissements.map((e) => [e.id, e]));
  const vueEtab = (id) => {
    const e = id && etab.get(id);
    return e ? { id: e.id, code: e.code, nom: e.nom, province: e.province, type: e.type, statut: e.statut }
      : { id: id ?? null, code: '', nom: id ? 'Établissement supprimé' : 'Sans établissement', province: '', type: '', statut: null };
  };
  const nbAmb = new Map(missionsAmb.map((m) => [m._id, m.n]));
  const nbChf = new Map(missionsChf.map((m) => [String(m._id), m.n]));
  const chf = new Map(chauffeurs.map((c) => [c.id, c]));
  const ambDe = new Map(ambulances.filter((a) => a.chauffeurId).map((a) => [String(a.chauffeurId), a]));
  res.json({
    ambulances: ambulances.map((a) => {
      const c = a.chauffeurId ? chf.get(String(a.chauffeurId)) : null;
      return {
        id: String(a._id), code: a.code, immatriculation: a.immatriculation, modele: a.modele, annee: a.annee, type: a.type,
        statut: a.statut, infirmier: a.infirmier, kilometrage: a.kilometrage, carburant: a.carburant,
        prochaineRevision: a.prochaineRevision ?? null, urgence: a.urgence, creeLe: a.createdAt,
        positionLe: a.position?.le ?? null, missions: nbAmb.get(a.code) ?? 0,
        etablissement: vueEtab(a.etablissementId),
        chauffeur: c ? { id: c.id, matricule: c.matricule, nom: `${c.prenom} ${c.nom}`, telephone: c.telephone, photo: c.photo ?? null } : null,
      };
    }),
    chauffeurs: chauffeurs.map((c) => {
      const a = ambDe.get(c.id);
      return {
        id: c.id, matricule: c.matricule, prenom: c.prenom, nom: c.nom, postnom: c.postnom, telephone: c.telephone,
        photo: c.photo ?? null, permis: c.permis ?? '', permisExpire: c.permisExpire ?? null, statut: c.statut,
        derniereConnexion: c.derniereConnexion, doitChangerMotDePasse: c.doitChangerMotDePasse, creeLe: c.createdAt,
        missions: nbChf.get(c.id) ?? 0,
        etablissement: vueEtab(c.etablissementId),
        ambulance: a ? { code: a.code, immatriculation: a.immatriculation, statut: a.statut } : null,
      };
    }),
  });
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

/**
 * Périmètre des statistiques du comité : `?etablissement=<id>`, `?provinceEtablissement=<province>`,
 * `?zoneSante=<zone>` (zone de la province). Les noms diffèrent de `province` / `aire`, déjà
 * utilisés par les analyses pour l'adresse des patientes. Renseigne req.perimetre : identifiants
 * des établissements retenus (liste éventuellement vide), ou null sans filtre (tout le système).
 */
exports.lirePerimetre = async (req, res, next) => {
  const lire = (cle) => (typeof req.query[cle] === 'string' ? req.query[cle].trim() : '');
  const etablissement = lire('etablissement');
  const province = lire('provinceEtablissement');
  const zone = lire('zoneSante');
  req.perimetre = null;
  if (!etablissement && !province && !zone) return next();

  if (etablissement && !mongoose.isValidObjectId(etablissement)) return res.status(400).json({ message: 'Établissement invalide.' });
  if (province && !PROVINCES_RDC.includes(province)) return res.status(400).json({ message: 'Province inconnue.' });
  if (zone && !province) return res.status(400).json({ message: 'Choisissez la province de la zone de santé.' });
  if (zone && !zonesDeProvince(province).includes(zone)) {
    return res.status(400).json({ message: `« ${zone} » n’est pas une zone de santé de la province ${province}.` });
  }
  const filtre = {};
  if (etablissement) filtre._id = etablissement;
  if (province) filtre.province = province;
  // Anciens établissements : une seule zone, dans `zoneSante`.
  if (zone) filtre.$or = [{ zonesSante: zone }, { zoneSante: zone }];
  req.perimetre = (await Etablissement.distinct('_id', filtre)).map(String);
  next();
};

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
    Etablissement.find(req.perimetre ? { _id: { $in: req.perimetre } } : {}).sort({ nom: 1 }),
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
      zonesSante: e.zonesSante?.length ? e.zonesSante : [e.zoneSante].filter(Boolean),
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
      zonesSante: new Set(lignes.flatMap((l) => l.zonesSante.map((z) => `${l.province}|${z}`))).size,
      sansMedecinChef: lignes.filter((l) => !l.medecinChef).length,
      // Un soignant qui exerce dans plusieurs établissements n'est compté qu'une fois.
      soignants: soignants.filter((s) => s.affectations.some((a) => lignes.some((l) => l.id === a.etablissementId))).length,
      ...Object.fromEntries(['patientes', 'grossessesEnCours', 'consultations', 'accouchements', 'enfants', 'urgences'].map((k) => [k, somme(k)])),
    },
    etablissements: lignes,
  });
};
