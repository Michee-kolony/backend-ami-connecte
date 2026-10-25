// Espace patiente (application mobile) : la patiente se connecte avec l'e-mail et le mot de passe
// choisis à son enregistrement, et ne lit que ses propres données et celles de ses enfants :
// grossesse en cours (datation, fiches CPN), rendez-vous (les siens et ceux de ses bébés), carnet vaccinal, croissance,
// accouchements, conseils de l'équipe soignante. Aucune donnée n'y est modifiable, sauf son mot de passe.
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
const cpn = require('../config/cpn');
const partogramme = require('../config/partogramme');
const { motDePasseValide } = require('./patientes');
const carte = require('./carte');
const { erreur, texte } = require('./saisie');

const { STATUTS_ACTIFS } = RendezVous;
/** Soignant figé dans un acte : nom et fonction seulement (ni identifiant ni matricule). */
const soignant = (a) => (a ? { nom: a.nom, role: a.role } : null);

exports.connexion = async (req, res) => {
  const email = texte(req.body?.email, 200).toLowerCase();
  const motDePasse = String(req.body?.motDePasse || '');
  if (!email || !motDePasse) throw erreur(400, 'E-mail et mot de passe requis.');
  const patiente = await Patiente.findOne({ email }).select('+motDePasse');
  // Même message dans tous les cas pour ne pas révéler quels e-mails existent.
  if (!patiente?.motDePasse || !(await bcrypt.compare(motDePasse, patiente.motDePasse))) {
    throw erreur(401, 'E-mail ou mot de passe incorrect.');
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

/** Rendez-vous lisibles par la patiente (consignes publiables, sans détail clinique). */
function rdvPourPatiente(r, prenoms) {
  return {
    id: r.id, date: r.date, motif: r.motif, lieu: r.lieu, consignes: r.consignes, statut: r.statut,
    enfant: r.enfantId ? { id: String(r.enfantId), prenom: prenoms.get(String(r.enfantId)) ?? '' } : null,
  };
}

/** Enfant vu par sa mère : identité, naissance (mensurations, APGAR), carnet, croissance, rendez-vous. */
async function enfantPourPatiente(e, rendezVous, prenoms) {
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
    rendezVous: rendezVous.filter((r) => String(r.enfantId) === e.id).map((r) => rdvPourPatiente(r, prenoms)),
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
  const debut = new Date(Date.now() - 86400000);
  const [grossesse, prochains, { enfants, prenoms }] = await Promise.all([
    Grossesse.findOne({ patienteId: p._id, statut: 'En cours' }).sort({ numero: -1 }),
    RendezVous.find({ patienteId: p._id, statut: { $in: STATUTS_ACTIFS }, date: { $gte: debut } }).sort({ date: 1 }).limit(10),
    donneesEnfants(p),
  ]);
  await journaliser(req, { action: 'espace.lecture', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'accueil' } });
  res.json({
    patiente: await profil(p),
    grossesse: grossesse ? {
      numero: grossesse.numero, agJours: grossesse.agJoursLe(), ddr: grossesse.datation?.ddr ?? null, dpa: grossesse.datation?.dpa ?? null,
    } : null,
    prochainsRendezVous: prochains.map((r) => rdvPourPatiente(r, prenoms)),
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
  res.json(rdvs.map((r) => rdvPourPatiente(r, prenoms)));
};

exports.enfants = async (req, res) => {
  const { enfants, rendezVous, prenoms } = await donneesEnfants(req.patiente);
  await journaliser(req, { action: 'espace.lecture', patienteId: req.patiente._id, ressource: { type: 'patiente', id: req.patiente.numero }, details: { page: 'enfants' } });
  res.json(await Promise.all(enfants.map((e) => enfantPourPatiente(e, rendezVous, prenoms))));
};

/** Un enfant de la patiente connectée (404 pour tout autre enfant : rien n'est révélé). */
exports.enfant = async (req, res) => {
  const e = mongoose.isValidObjectId(req.params.id) && await Enfant.findOne({ _id: req.params.id, mereId: req.patiente._id });
  if (!e) throw erreur(404, 'Enfant introuvable.');
  const rendezVous = await RendezVous.find({ enfantId: e._id }).sort({ date: 1 });
  await journaliser(req, { action: 'espace.lecture', patienteId: req.patiente._id, ressource: { type: 'enfant', id: e.numero } });
  res.json(await enfantPourPatiente(e, rendezVous, new Map([[e.id, e.prenom]])));
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
  res.json({
    grossesse: {
      id: g.id, numero: g.numero, statut: g.statut, grossesseMultiple: g.grossesseMultiple,
      agJours: g.statut === 'En cours' ? g.agJoursLe() : null,
      datation: d ? { methode: d.methode, ddr: d.ddr, ddrFiabilite: d.ddrFiabilite, dateReference: d.dateReference, dpa: d.dpa } : null,
      issue: g.issue ? { date: g.issue.date, issue: g.issue.issue, mode: g.issue.mode } : null,
    },
    consultations: consultations.map(fichePourPatiente),
    rendezVous: rendezVous.map((r) => rdvPourPatiente(r, new Map())),
  });
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
