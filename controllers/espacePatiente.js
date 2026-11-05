// Espace patiente (application mobile) : la patiente se connecte avec son e-mail ou son matricule et le mot de passe
// choisis à son enregistrement, et ne lit que ses propres données et celles de ses enfants :
// grossesse en cours (datation, fiches CPN), rendez-vous (les siens et ceux de ses bébés), carnet vaccinal, croissance,
// accouchements, données de son enregistrement CPN, conseils de l'équipe soignante. Aucune donnée n'y
// est modifiable, sauf son mot de passe.
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Patiente = require('../models/Patiente');
const Grossesse = require('../models/Grossesse');
const Enfant = require('../models/Enfant');
const RendezVous = require('../models/RendezVous');
const Accouchement = require('../models/Accouchement');
const Etablissement = require('../models/Etablissement');
const Consultation = require('../models/Consultation');
const Article = require('../models/Article');
const Soignant = require('../models/Soignant');
const { journaliser } = require('../config/audit');
const notifications = require('../config/notifications');
const { urlSignee } = require('../config/r2');
const acc = require('../config/accouchement');
const { jourKinshasa } = require('../config/vaccination');
const cpn = require('../config/cpn');
const partogramme = require('../config/partogramme');
const { motDePasseValide } = require('./patientes');
const carte = require('./carte');
const { erreur, texte } = require('./saisie');

const { STATUTS_ACTIFS } = RendezVous;
const JOUR = 86400000;
/** Durée pendant laquelle un rendez-vous raté est rappelé sur l'accueil. */
const RAPPEL_RDV_MANQUE_JOURS = 30;
const debutDuJour = () => new Date(`${jourKinshasa()}T00:00:00+01:00`);
/** Soignant figé dans un acte : nom et fonction seulement (ni identifiant ni matricule). */
const soignant = (a) => (a ? { nom: a.nom, role: a.role } : null);

exports.connexion = async (req, res) => {
  // « email » : champ envoyé par les versions de l'application déjà installées.
  const identifiant = texte(req.body?.identifiant ?? req.body?.email, 200);
  const motDePasse = String(req.body?.motDePasse || '');
  if (!identifiant || !motDePasse) throw erreur(400, 'E-mail ou matricule et mot de passe requis.');
  const recherche = identifiant.includes('@') ? { email: identifiant.toLowerCase() } : { numero: identifiant.toUpperCase() };
  const patiente = await Patiente.findOne(recherche).select('+motDePasse');
  // Même message dans tous les cas pour ne pas révéler quels comptes existent.
  if (!patiente?.motDePasse || !(await bcrypt.compare(motDePasse, patiente.motDePasse))) {
    throw erreur(401, 'Identifiant ou mot de passe incorrect.');
  }
  if (patiente.espaceEnLigne !== 'Activé') throw erreur(403, 'Votre espace n’est pas encore activé : adressez-vous à votre centre de santé.');
  const jeton = jwt.sign({ sub: patiente.id, typ: 'patiente' }, process.env.JWT_SECRET, {
    expiresIn: process.env.JWT_PATIENTE_EXPIRES_IN || '30d',
  });
  req.patiente = patiente;
  await journaliser(req, { action: 'espace.connexion', patienteId: patiente._id, ressource: { type: 'patiente', id: patiente.numero } });
  res.json({ jeton, patiente: await profil(patiente) });
};

async function profil(p) {
  const [etablissement] = p.etablissementId ? await Etablissement.actifsParIds([p.etablissementId]) : [];
  return {
    id: p.id, numero: p.numero, nom: p.nom, postnom: p.postnom, prenom: p.prenom, age: p.age(),
    email: p.email, telephone: p.telephone, statut: p.statut, photoUrl: await urlSignee(p.photoCle),
    etablissement: etablissement ? { nom: etablissement.nom, province: etablissement.province, telephone: etablissement.telephone } : null,
  };
}

exports.moi = async (req, res) => {
  res.json(await profil(req.patiente));
};

/** Carte patiente (PDF), même modèle que celle imprimée par le médecin. */
exports.carte = carte.cartePatiente;
exports.apercuCarte = carte.apercuPatiente;

const DUREE_LIEN_CARTE = '5m';

/**
 * Lien de téléchargement de la carte, valable 5 minutes : le téléphone l'ouvre dans son lecteur
 * PDF (impression, partage) sans y transmettre le jeton de session de la patiente.
 */
exports.lienCarte = async (req, res) => {
  const jeton = jwt.sign({ sub: req.patiente.id, typ: 'carte-patiente' }, process.env.JWT_SECRET, { expiresIn: DUREE_LIEN_CARTE });
  res.json({ chemin: `/espace-patiente/carte.pdf?jeton=${encodeURIComponent(jeton)}` });
};

/** GET /espace-patiente/carte.pdf?jeton=… — carte ouverte par le lien temporaire. */
exports.carteParLien = async (req, res) => {
  let sub;
  try {
    ({ sub } = jwt.verify(String(req.query.jeton || ''), process.env.JWT_SECRET, { maxAge: DUREE_LIEN_CARTE }));
    if (jwt.decode(String(req.query.jeton)).typ !== 'carte-patiente') throw new Error('type');
  } catch {
    throw erreur(401, 'Lien expiré : téléchargez à nouveau la carte depuis l’application.');
  }
  const patiente = await Patiente.findById(sub);
  if (!patiente || patiente.espaceEnLigne !== 'Activé') throw erreur(401, 'Compte inactif ou introuvable.');
  req.patiente = patiente;
  return carte.cartePatiente(req, res);
};

exports.changerMotDePasse = async (req, res) => {
  const p = await Patiente.findById(req.patiente._id).select('+motDePasse');
  if (!(await bcrypt.compare(String(req.body?.actuel || ''), p.motDePasse || ''))) throw erreur(400, 'Mot de passe actuel incorrect.');
  const nouveau = req.body?.nouveau;
  if (!motDePasseValide(nouveau)) throw erreur(400, 'Mot de passe trop faible : 8 caractères au moins, avec des lettres et des chiffres.');
  p.motDePasse = await bcrypt.hash(nouveau, 12);
  await p.save();
  res.json({ message: 'Mot de passe modifié.' });
};

/**
 * Rendez-vous ratés parmi ceux donnés : absence notée par le centre, ou jour passé sans suite.
 * Même prudence que la relance (config/moteurRelance.js) : on ne dit pas à une maman qu'elle a raté
 * un rendez-vous si elle a été vue depuis la veille de celui-ci, un autre jour que prévu. Pour un
 * enfant, la vaccination clôt déjà tous les rendez-vous passés.
 */
async function rdvManques(patiente, rdvs) {
  const aujourdhui = debutDuJour();
  const passes = rdvs.filter((r) => r.statut === 'Absent' || (STATUTS_ACTIFS.includes(r.statut) && r.date < aujourdhui));
  if (!passes.length) return new Set();
  const [consultations, effectues] = await Promise.all([
    Consultation.find({ patienteId: patiente._id, statut: { $ne: 'Annulée' } }).select('date'),
    RendezVous.find({ patienteId: patiente._id, enfantId: null, statut: 'Effectué' }).select('date'),
  ]);
  const derniere = (liste) => Math.max(0, ...liste.map((x) => x.date.getTime()));
  const consultee = derniere(consultations);
  const honore = derniere(effectues);
  const vueDepuis = (r) => !r.enfantId && (consultee >= r.date.getTime() - JOUR || honore > r.date.getTime());
  return new Set(passes.filter((r) => r.statut === 'Absent' || !vueDepuis(r)).map((r) => r.id));
}

/** Rendez-vous lisibles par la patiente (consignes publiables, sans détail clinique). */
function rdvPourPatiente(r, prenoms, manques = new Set()) {
  return {
    id: r.id, date: r.date, motif: r.motif, lieu: r.lieu, consignes: r.consignes, statut: r.statut, manque: manques.has(r.id),
    enfant: r.enfantId ? { id: String(r.enfantId), prenom: prenoms.get(String(r.enfantId)) ?? '' } : null,
  };
}

/** Enfant vu par sa mère : identité, naissance (mensurations, APGAR), carnet, croissance, rendez-vous. */
async function enfantPourPatiente(e, rendezVous, prenoms, manques) {
  const n = e.naissance ?? {};
  return {
    photoUrl: await urlSignee(e.photoCle),
    id: e.id, numero: e.numero, nom: e.nom, postnom: e.postnom, prenom: e.prenom, sexe: e.sexe,
    neLe: e.neLe, dateNaissance: e.dateNaissance, rang: e.rang, etatNaissance: e.etatNaissance, statut: e.statut, age: e.age(),
    naissance: {
      poidsG: n.poidsG ?? null, tailleCm: n.tailleCm ?? null, perimetreCranienCm: n.perimetreCranienCm ?? null,
      apgar: { m1: n.apgar?.m1?.total ?? null, m5: n.apgar?.m5?.total ?? null, m10: n.apgar?.m10?.total ?? null },
      vitamineK1: n.traitement?.vitamineK1 ?? null,
    },
    carnet: e.carnet(),
    croissance: [...e.suivis].sort((a, b) => a.date.localeCompare(b.date)).map((s) => ({
      date: s.date, poidsG: s.poidsG, tailleCm: s.tailleCm, perimetreCranienCm: s.perimetreCranienCm,
      perimetreBrachialCm: s.perimetreBrachialCm, alimentation: s.alimentation, observations: s.observations, soignant: soignant(s.auteur),
    })),
    rendezVous: rendezVous.filter((r) => String(r.enfantId) === e.id).map((r) => rdvPourPatiente(r, prenoms, manques)),
  };
}

async function donneesEnfants(patiente) {
  const [enfants, rendezVous] = await Promise.all([
    Enfant.find({ mereId: patiente._id }).sort({ neLe: -1 }),
    RendezVous.find({ patienteId: patiente._id, enfantId: { $ne: null } }).sort({ date: 1 }),
  ]);
  const prenoms = new Map(enfants.map((e) => [e.id, e.prenom]));
  return { enfants, rendezVous, prenoms };
}

/**
 * Accueil de l'application : grossesse en cours, prochains rendez-vous (mère et enfants),
 * et pour chaque enfant la prochaine séance de vaccination et les retards.
 */
exports.accueil = async (req, res) => {
  const p = req.patiente;
  const debut = debutDuJour();
  const [grossesse, prochains, { enfants, prenoms }, recents] = await Promise.all([
    Grossesse.findOne({ patienteId: p._id, statut: 'En cours' }).sort({ numero: -1 }),
    RendezVous.find({ patienteId: p._id, statut: { $in: STATUTS_ACTIFS }, date: { $gte: debut } }).sort({ date: 1 }).limit(10),
    donneesEnfants(p),
    RendezVous.find({
      patienteId: p._id, statut: { $in: [...STATUTS_ACTIFS, 'Absent'] },
      date: { $gte: new Date(debut - RAPPEL_RDV_MANQUE_JOURS * JOUR), $lt: debut },
    }).sort({ date: -1 }),
  ]);
  // Rappel du dernier rendez-vous raté, tant qu'aucun autre n'est prévu pour la même personne.
  const manques = await rdvManques(p, recents);
  const rate = recents.find((r) => manques.has(r.id) && !prochains.some((x) => String(x.enfantId) === String(r.enfantId)));
  await journaliser(req, { action: 'espace.lecture', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'accueil' } });
  res.json({
    patiente: await profil(p),
    grossesse: grossesse ? {
      numero: grossesse.numero, agJours: grossesse.agJoursLe(), ddr: grossesse.datation?.ddr ?? null, dpa: grossesse.datation?.dpa ?? null,
    } : null,
    prochainsRendezVous: prochains.map((r) => rdvPourPatiente(r, prenoms)),
    rendezVousManque: rate ? rdvPourPatiente(rate, prenoms, manques) : null,
    enfants: await Promise.all(enfants.map(async (e) => {
      const carnet = e.carnet();
      return {
        photoUrl: await urlSignee(e.photoCle),
        id: e.id, prenom: e.prenom, nom: e.nom, sexe: e.sexe, dateNaissance: e.dateNaissance, age: e.age(), statut: e.statut,
        etatNaissance: e.etatNaissance,
        vaccination: carnet ? { prochaineSeance: carnet.prochaineSeance, ...carnet.resume } : null,
      };
    })),
  });
};

exports.rendezVous = async (req, res) => {
  const p = req.patiente;
  const [rdvs, enfants] = await Promise.all([
    RendezVous.find({ patienteId: p._id }).sort({ date: -1 }).limit(300),
    Enfant.find({ mereId: p._id }).select('prenom'),
  ]);
  const prenoms = new Map(enfants.map((e) => [e.id, e.prenom]));
  await journaliser(req, { action: 'espace.lecture', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'rendez-vous' } });
  const manques = await rdvManques(p, rdvs);
  res.json(rdvs.map((r) => rdvPourPatiente(r, prenoms, manques)));
};

exports.enfants = async (req, res) => {
  const { enfants, rendezVous, prenoms } = await donneesEnfants(req.patiente);
  await journaliser(req, { action: 'espace.lecture', patienteId: req.patiente._id, ressource: { type: 'patiente', id: req.patiente.numero }, details: { page: 'enfants' } });
  const manques = await rdvManques(req.patiente, rendezVous);
  res.json(await Promise.all(enfants.map((e) => enfantPourPatiente(e, rendezVous, prenoms, manques))));
};

/** Un enfant de la patiente connectée (404 pour tout autre enfant : rien n'est révélé). */
exports.enfant = async (req, res) => {
  const e = mongoose.isValidObjectId(req.params.id) && await Enfant.findOne({ _id: req.params.id, mereId: req.patiente._id });
  if (!e) throw erreur(404, 'Enfant introuvable.');
  const rendezVous = await RendezVous.find({ enfantId: e._id }).sort({ date: 1 });
  await journaliser(req, { action: 'espace.lecture', patienteId: req.patiente._id, ressource: { type: 'enfant', id: e.numero } });
  res.json(await enfantPourPatiente(e, rendezVous, new Map([[e.id, e.prenom]]), await rdvManques(req.patiente, rendezVous)));
};

/** Examen clinique d'entrée vu par la patiente : constantes, examen obstétrical, conclusion. */
function examenPourPatiente(ex) {
  if (!ex) return null;
  const ph = ex.physique ?? {};
  const o = ex.obstetrical ?? {};
  return {
    le: ex.examineLe, soignant: soignant(ex.examinateur),
    poidsKg: ph.poidsKg ?? null, temperature: ph.temperature ?? null, pouls: ph.pouls ?? null,
    taSystolique: ph.taSystolique ?? null, taDiastolique: ph.taDiastolique ?? null,
    hauteurUterineCm: o.hauteurUterineCm ?? null, presentation: o.presentation ?? '',
    contractions10min: o.contractions10min ?? null, effacementPct: o.toucherVaginal?.effacementPct ?? null,
    pocheEaux: o.pocheEaux?.etat ?? '', conclusion: ex.conclusion ?? '',
  };
}

const CRENEAUX = new Map(acc.CRENEAUX_POST_PARTUM.map((c) => [c.code, c.libelle]));

/**
 * Accouchements, y compris le travail en cours : examen d'entrée, mesures du travail (BCF,
 * dilatation… de l'examen d'entrée et de la surveillance), accouchement, contrôles post-partum,
 * traitements, sortie, conseils et mesures préventives. Les alertes internes ne sont pas exposées.
 */
exports.accouchements = async (req, res) => {
  const p = req.patiente;
  const [dossiers, enfants] = await Promise.all([
    Accouchement.find({ patienteId: p._id }).sort({ 'admission.admiseLe': -1 }),
    Enfant.find({ mereId: p._id }).select('prenom sexe neLe etatNaissance accouchementId'),
  ]);
  const libelles = (liste, valeurs) => liste.filter(({ code }) => valeurs?.[code] === true).map(({ libelle }) => libelle);
  await journaliser(req, { action: 'espace.lecture', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'accouchements' } });
  res.json(dossiers.map((a) => {
    const pp = a.postPartum ?? {};
    const enfantsDuDossier = enfants.filter((e) => String(e.accouchementId) === a.id);
    const prenoms = new Map(enfantsDuDossier.map((e) => [e.id, e.prenom]));
    const travail = partogramme.mesures(a).surveillances
      .map((s) => ({
        le: s.le, phase: s.phase, examenEntree: String(s._id).startsWith('examen-entree'),
        bcf: s.bcf ?? null, dilatationCm: s.dilatationCm ?? null, effacementPct: s.effacementPct ?? null,
        contractions10min: s.contractions10min ?? null, temperature: s.temperature ?? null, pouls: s.pouls ?? null,
        taSystolique: s.taSystolique ?? null, taDiastolique: s.taDiastolique ?? null,
        soignant: soignant(s.auteur),
      }))
      .sort((x, y) => y.le - x.le);
    return {
      id: a.id, numero: a.numero, statut: a.statut, admiseLe: a.admission.admiseLe,
      date: a.accouchement?.heure ?? null, mode: a.accouchement?.mode ?? '', multiple: a.accouchement?.multiple ?? null,
      accoucheur: a.accouchement?.accoucheur ?? '',
      examen: examenPourPatiente(a.examenClinique),
      travail,
      postPartum: (pp.surveillances ?? []).map((s) => ({
        le: s.le, creneau: CRENEAUX.get(s.creneau) ?? s.creneau,
        taSystolique: s.mere?.taSystolique ?? null, taDiastolique: s.mere?.taDiastolique ?? null,
        pouls: s.mere?.pouls ?? null, temperature: s.mere?.temperature ?? null, saignement: s.mere?.saignement ?? '',
        observations: s.observations ?? '', soignant: soignant(s.auteur),
      })).sort((x, y) => y.le - x.le),
      traitements: (pp.traitements ?? []).map((t) => ({
        pour: t.pour === 'Nouveau-né' ? prenoms.get(String(t.enfantId)) || 'Bébé' : 'Vous',
        produit: t.produit, dose: t.dose, voie: t.voie, frequence: t.frequence, duree: t.duree,
        statut: t.statut, administreLe: t.administreLe,
      })),
      enfants: enfantsDuDossier
        .map((e) => ({ id: e.id, prenom: e.prenom, sexe: e.sexe, neLe: e.neLe, etatNaissance: e.etatNaissance })),
      sortie: pp.sortie ? { date: pp.sortie.date, rdvCpon: pp.sortie.rdvCpon, observations: pp.sortie.observations } : null,
      conseils: pp.conseils ?? '',
      mesuresPreventives: {
        mere: libelles(acc.MESURES_SORTIE_MERE, pp.mesuresPreventives?.mere),
        nouveauNe: libelles(acc.MESURES_SORTIE_NOUVEAU_NE, pp.mesuresPreventives?.nouveauNe),
      },
    };
  }));
};

const ARTICLES_MAX = 50;
const ROLE_PATIENTE = 'Patiente';

/** Auteur d'un commentaire de patiente (même forme que celui d'un soignant). */
const auteurPatiente = (p) => ({ id: p.id, nom: `${p.prenom} ${p.nom}`.trim(), role: ROLE_PATIENTE, matricule: p.numero });

/** « Esther MBUYI » → « Esther M. » : une patiente n'est pas nommée en entier devant les autres. */
function nomAbrege(nom) {
  const [prenom, ...reste] = String(nom).trim().split(/\s+/);
  return reste.length ? `${prenom} ${reste.at(-1).charAt(0).toUpperCase()}.` : prenom;
}

/** Photos (URL signées) des soignants et de la patiente connectée cités dans les articles. */
async function photosAuteurs(articles, p) {
  const ids = new Set();
  for (const a of articles) {
    ids.add(a.auteur.id);
    for (const c of a.commentaires) {
      if (c.auteur.role !== ROLE_PATIENTE) ids.add(c.auteur.id);
      for (const r of c.reponses) ids.add(r.auteur.id);
    }
  }
  const valides = [...ids].filter((id) => mongoose.isValidObjectId(id));
  const soignants = await Soignant.find({ _id: { $in: valides } }).select('+photoCle photo');
  const photos = new Map(await Promise.all(soignants.map(async (s) => [s.id, (await urlSignee(s.photoCle)) ?? s.photo ?? null])));
  photos.set(p.id, await urlSignee(p.photoCle));
  return photos;
}

/** Auteur affiché à la patiente : soignant complet ; autre patiente abrégée, sans photo. */
function auteurVisible(a, p, photos) {
  if (a.role === ROLE_PATIENTE) {
    const moi = a.id === p.id;
    return { nom: moi ? a.nom : nomAbrege(a.nom), role: ROLE_PATIENTE, photoUrl: moi ? photos.get(p.id) ?? null : null, moi };
  }
  return { nom: a.nom, role: a.role, photoUrl: photos.get(a.id) ?? null, moi: false };
}

/** Article vu par la patiente : médias, photo du médecin, j'aime et commentaires (réponses du médecin). */
function articlePourPatiente(a, p, photos) {
  return {
    id: a.id, titre: a.titre, contenu: a.contenu, cible: a.cible,
    medias: a.medias.map((m) => ({ type: m.type, url: m.url })),
    auteur: { ...soignant(a.auteur), photoUrl: photos.get(a.auteur.id) ?? null },
    publieLe: a.createdAt,
    nbJaimes: a.jaimes.length,
    jAime: a.jaimes.includes(p.id),
    commentaires: a.commentaires.map((c) => ({
      id: c.id, texte: c.texte, le: c.le, auteur: auteurVisible(c.auteur, p, photos),
      reponses: c.reponses.map((r) => ({ id: r.id, texte: r.texte, le: r.le, auteur: auteurVisible(r.auteur, p, photos) })),
    })),
  };
}

async function vueArticle(a, p) {
  return articlePourPatiente(a, p, await photosAuteurs([a], p));
}

/** Article approuvé (un article en attente d'approbation reste invisible : 404). */
async function articleApprouve(id) {
  const a = mongoose.isValidObjectId(id) && await Article.findById(id);
  if (!a || a.statut === 'En attente') throw erreur(404, 'Article introuvable.');
  return a;
}

/**
 * Conseils des médecins : ceux donnés à la patiente (consultations finalisées, sortie de la
 * maternité), puis les articles de conseils approuvés par le médecin chef, que la patiente
 * peut aimer et commenter.
 */
exports.conseils = async (req, res) => {
  const p = req.patiente;
  const nonVide = { $exists: true, $nin: ['', null] };
  const [consultations, dossiers, articles] = await Promise.all([
    Consultation.find({ patienteId: p._id, statut: 'Finalisée', conseils: nonVide }).select('type date conseils auteur'),
    Accouchement.find({ patienteId: p._id, 'postPartum.conseils': nonVide }).select('accouchement.heure postPartum.conseils postPartum.sortie'),
    Article.find({ statut: { $ne: 'En attente' } }).sort({ createdAt: -1 }).limit(ARTICLES_MAX),
  ]);
  const personnels = [
    ...consultations.map((c) => ({
      id: c.id, origine: 'Consultation', titre: c.type, date: c.date, texte: c.conseils, soignant: soignant(c.auteur),
    })),
    ...dossiers.map((a) => ({
      id: a.id, origine: 'Accouchement', titre: 'Sortie de la maternité',
      date: a.postPartum.sortie?.le ?? a.accouchement?.heure ?? null, texte: a.postPartum.conseils,
      soignant: soignant(a.postPartum.sortie?.examinePar),
    })),
  ].sort((x, y) => new Date(y.date ?? 0) - new Date(x.date ?? 0));
  const photos = await photosAuteurs(articles, p);
  await journaliser(req, { action: 'espace.lecture', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'conseils' } });
  res.json({ personnels, articles: articles.map((a) => articlePourPatiente(a, p, photos)) });
};

/** J'aime / je n'aime plus (bascule). */
exports.aimerArticle = async (req, res) => {
  const p = req.patiente;
  const a = await articleApprouve(req.params.id);
  await Article.updateOne({ _id: a._id }, a.jaimes.includes(p.id) ? { $pull: { jaimes: p.id } } : { $addToSet: { jaimes: p.id } });
  res.json(await vueArticle(await articleApprouve(req.params.id), p));
};

exports.commenterArticle = async (req, res) => {
  const t = texte(req.body?.texte, 2000);
  if (!t) throw erreur(400, 'Le commentaire est vide.');
  const a = await articleApprouve(req.params.id);
  a.commentaires.push({ auteur: auteurPatiente(req.patiente), texte: t, le: new Date() });
  await a.save();
  await journaliser(req, { action: 'espace.commentaire', patienteId: req.patiente._id, ressource: { type: 'article', id: a.id } });
  res.status(201).json(await vueArticle(a, req.patiente));
};

/** La patiente ne supprime que ses propres commentaires (le médecin chef les modère dans ami-sante). */
exports.supprimerCommentaireArticle = async (req, res) => {
  const a = await articleApprouve(req.params.id);
  const c = mongoose.isValidObjectId(req.params.cid) && a.commentaires.id(req.params.cid);
  if (!c) throw erreur(404, 'Commentaire introuvable.');
  if (c.auteur.role !== ROLE_PATIENTE || c.auteur.id !== req.patiente.id) throw erreur(403, 'Vous ne pouvez supprimer que vos propres commentaires.');
  c.deleteOne();
  await a.save();
  await journaliser(req, { action: 'espace.commentaire.suppression', patienteId: req.patiente._id, ressource: { type: 'article', id: a.id } });
  res.json(await vueArticle(a, req.patiente));
};

/**
 * Mesures préventives VIH / PTME (codes, résultats de test, CD4, TAR) : non affichées sur le
 * téléphone, qui peut être vu par d'autres personnes. Elles restent dans le dossier du centre.
 */
const GROUPES_NON_AFFICHES = ['VIH', 'PTME'];
const CONSTANTES = ['poidsKg', 'taSystolique', 'taDiastolique', 'temperature', 'pouls', 'hauteurUterineCm', 'bcf', 'saO2', 'frequenceRespiratoire'];

/** Fiche CPN finalisée, lisible par la patiente (sans les notes de raisonnement du médecin). */
function fichePourPatiente(c) {
  const ex = c.examenCpn ?? {};
  return {
    id: c.id, type: c.type, date: c.date, agJours: c.agJours, soignant: soignant(c.auteur), motif: c.motif,
    constantes: Object.fromEntries(CONSTANTES.map((k) => [k, c.constantes?.[k] ?? null])),
    examen: {
      etatGeneral: ex.etatGeneral || null, presentation: ex.presentation || null,
      mouvementsFoetaux: ex.mouvementsFoetaux || null, perimetreBrachialCm: ex.perimetreBrachialCm ?? null,
      signes: cpn.SIGNES_CPN.filter((x) => ex.signes?.[x.code] === true).map((x) => x.libelle),
    },
    mesuresPreventives: cpn.MESURES_PREVENTIVES
      .filter((m) => !GROUPES_NON_AFFICHES.includes(m.groupe) && c.mesuresPreventives?.[m.code]?.reponse === true)
      .map((m) => ({ libelle: m.libelle, valeur: c.mesuresPreventives[m.code].valeur || '' })),
    laboratoire: cpn.EXAMENS_LABO.filter((e) => c.laboratoire?.[e.code]).map((e) => ({ libelle: e.libelle, resultat: c.laboratoire[e.code] })),
    echographie: c.echographie,
    traitements: c.traitements.map((t) => ({ produit: t.produit, dose: t.dose, voie: t.voie, frequence: t.frequence, duree: t.duree })),
    examensDemandes: c.examensDemandes,
    conseils: c.conseils,
    orientation: c.orientation,
    prochainRdv: c.prochainRdv?.date ? { date: c.prochainRdv.date, motif: c.prochainRdv.motif, consignes: c.prochainRdv.consignes } : null,
    addenda: c.addenda.map((a) => ({ texte: a.texte, le: a.le, soignant: soignant(a.auteur) })),
  };
}

/**
 * Ma grossesse : la grossesse en cours (sinon la plus récente) avec sa datation (DDR, DPA),
 * ses fiches de consultation CPN finalisées et ses rendez-vous de suivi.
 */
exports.grossesse = async (req, res) => {
  const p = req.patiente;
  const g = await Grossesse.findOne({ patienteId: p._id, statut: 'En cours' }).sort({ numero: -1 })
    ?? await Grossesse.findOne({ patienteId: p._id }).sort({ numero: -1 });
  await journaliser(req, { action: 'espace.lecture', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'grossesse' } });
  if (!g) return res.json({ grossesse: null, consultations: [], rendezVous: [] });
  const [consultations, rendezVous] = await Promise.all([
    Consultation.find({ grossesseId: g._id, statut: 'Finalisée' }).sort({ date: -1 }),
    RendezVous.find({ patienteId: p._id, enfantId: null, $or: [{ grossesseId: g._id }, { grossesseId: null }] }).sort({ date: 1 }),
  ]);
  const d = g.datation;
  const manques = await rdvManques(p, rendezVous);
  res.json({
    grossesse: {
      id: g.id, numero: g.numero, statut: g.statut, grossesseMultiple: g.grossesseMultiple,
      agJours: g.statut === 'En cours' ? g.agJoursLe() : null,
      datation: d ? { methode: d.methode, ddr: d.ddr, ddrFiabilite: d.ddrFiabilite, dateReference: d.dateReference, dpa: d.dpa } : null,
      issue: g.issue ? { date: g.issue.date, issue: g.issue.issue, mode: g.issue.mode } : null,
    },
    consultations: consultations.map(fichePourPatiente),
    rendezVous: rendezVous.map((r) => rdvPourPatiente(r, new Map(), manques)),
  });
};

/** Antécédents jamais affichés sur le téléphone, qui peut être vu par l'entourage (comme le PTME). */
const ATCD_NON_AFFICHES = ['VIH/SIDA', 'Viol'];

/**
 * Données saisies à l'enregistrement CPN, par rubrique (lignes renseignées seulement), antécédents
 * en tête. Une ligne à cases cochées porte aussi `valeurs` ; les allergies portent `alerte`.
 */
function rubriquesDossier(p) {
  const a = p.adresse ?? {};
  const u = p.contactUrgence ?? {};
  const atcd = p.antecedents ?? {};
  const c = p.consentements ?? {};
  const date = (d) => (d ? d.split('-').reverse().join('/') : '');
  const rubriques = [
    ['medical', 'Antécédents médicaux et chirurgicaux', [
      ['Allergies', atcd.allergies, { alerte: true }],
      ['Antécédents médicaux', (atcd.atcdMedicaux ?? []).filter((x) => !ATCD_NON_AFFICHES.includes(x))], ['Autres antécédents médicaux', atcd.medicaux],
      ['Antécédents gynécologiques et chirurgicaux', atcd.atcdGynecoChirurgicaux], ['Autres antécédents chirurgicaux', atcd.chirurgicaux],
      ['Médicaments en cours', atcd.medicaments],
    ]],
    ['obstetrical', 'Antécédents obstétricaux', [
      ['Grossesses', atcd.gestite], ['Accouchements', atcd.parite], ['Enfants vivants', atcd.enfantsVivants],
      ['Avortements', atcd.avortements], ['Césariennes', atcd.cesariennes], ['Particularités', atcd.atcdObstetricaux],
      ['Complications', atcd.complicationsObstetricales], ['Dernier accouchement', date(atcd.dernierAccouchement)],
      ['Plus gros poids de naissance', atcd.plusGrosPoidsNaissanceG != null ? `${atcd.plusGrosPoidsNaissanceG} g` : ''],
    ]],
    ['biologie', 'Profil biologique', [
      ['Groupe sanguin', p.groupeSanguin], ['Rhésus', p.rhesus], ['Électrophorèse de l’hémoglobine', p.electrophoreseHb],
      ['Taille', p.tailleCm != null ? `${p.tailleCm} cm` : ''],
    ]],
    ['identite', 'Mon identité', [
      ['Matricule', p.numero], ['Nom complet', [p.prenom, p.nom, p.postnom].filter(Boolean).join(' ')],
      ['Date de naissance', date(p.dateNaissance)], ['Âge', p.age() != null ? `${p.age()} ans` : ''],
      ['Pièce d’identité', p.pieceIdentite], ['État civil', p.etatCivil], ['Occupation', p.occupation],
      ['Partenaire', p.nomPartenaire], ['Occupation du partenaire', p.occupationPartenaire],
    ]],
    ['coordonnees', 'Mes coordonnées', [
      ['Téléphone', p.telephone], ['Autre téléphone', p.telephone2], ['E-mail', p.email],
      ['Province', a.province], ['Commune', a.commune], ['Quartier', a.quartier], ['Avenue', a.avenue],
      ['Repère', a.repere], ['Aire de santé', a.aireSante],
    ]],
    ['urgence', 'Personne à prévenir', [['Nom', u.nom], ['Lien', u.lien], ['Téléphone', u.telephone], ['Adresse', u.adresse]]],
    ['contact', 'Contact par le centre de santé', [
      ['Canaux acceptés', [['SMS', c.sms], ['Appel', c.appel], ['WhatsApp', c.whatsapp]].filter(([, ok]) => ok === true).map(([canal]) => canal)],
    ]],
  ];
  const renseignee = ([, v]) => (Array.isArray(v) ? v.length > 0 : v != null && v !== '');
  const ligne = ([libelle, v, options]) => (Array.isArray(v)
    ? { libelle, valeur: v.join(', '), valeurs: [...v] }
    : { libelle, valeur: String(v), ...options });
  return rubriques
    .map(([code, titre, lignes]) => ({ code, titre, lignes: lignes.filter(renseignee).map(ligne) }))
    .filter((r) => r.lignes.length);
}

const ESSAIS_DOSSIER_MAX = 5;
const BLOCAGE_DOSSIER_MS = 15 * 60000;
/** Essais manqués par patiente (en mémoire : remis à zéro au redémarrage du serveur). */
const essaisDossier = new Map();

/** Mauvais mot de passe : 400 et non 401, qui déconnecterait l'application. */
async function refuserDossier(req, essais) {
  const p = req.patiente;
  const echecs = (essais?.bloqueJusquA ? 0 : essais?.echecs ?? 0) + 1;
  essaisDossier.set(p.id, { echecs, bloqueJusquA: echecs >= ESSAIS_DOSSIER_MAX ? Date.now() + BLOCAGE_DOSSIER_MS : 0 });
  await journaliser(req, { action: 'acces.refuse', resultat: 'refusé', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'dossier', echecs } });
  throw erreur(400, 'Mot de passe incorrect.');
}

/**
 * Dossier d'enregistrement : la patiente relit ce qui a été saisi, sans pouvoir le modifier.
 * Données confidentielles : son mot de passe est redemandé à chaque ouverture, même connectée,
 * pour qu'un téléphone déverrouillé ne suffise pas.
 */
exports.dossier = async (req, res) => {
  const p = req.patiente;
  const essais = essaisDossier.get(p.id);
  if (essais?.bloqueJusquA > Date.now()) throw erreur(429, 'Trop d’essais : réessayez dans 15 minutes.');
  const { motDePasse } = await Patiente.findById(p._id).select('+motDePasse');
  if (!(await bcrypt.compare(String(req.body?.motDePasse || ''), motDePasse || ''))) await refuserDossier(req, essais);
  essaisDossier.delete(p.id);
  await journaliser(req, { action: 'espace.lecture', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'dossier' } });
  res.json({ enregistreeLe: p.createdAt, rubriques: rubriquesDossier(p) });
};

/** Téléphone de la patiente : jeton Firebase pour recevoir les notifications push. */
exports.enregistrerAppareil = async (req, res) => {
  const jeton = texte(req.body?.jeton, 4096);
  if (!jeton) throw erreur(400, 'Jeton de notification requis.');
  const plateforme = ['android', 'ios', 'web'].includes(req.body?.plateforme) ? req.body.plateforme : 'android';
  await notifications.enregistrerAppareil(req.patiente._id, jeton, plateforme);
  res.status(204).end();
};

/** Déconnexion du téléphone : il ne reçoit plus de notifications. */
exports.retirerAppareil = async (req, res) => {
  const jeton = texte(req.body?.jeton, 4096);
  if (jeton) await notifications.retirerAppareil(req.patiente._id, jeton);
  res.status(204).end();
};
