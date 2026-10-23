// Espace patiente (application mobile) : la patiente se connecte avec l'e-mail et le mot de passe
// choisis à son enregistrement, et ne lit que ses propres données et celles de ses enfants :
// grossesse en cours, rendez-vous (les siens et ceux de ses bébés), carnet vaccinal, croissance,
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
const { journaliser } = require('../config/audit');
const { urlSignee } = require('../config/r2');
const acc = require('../config/accouchement');
const { motDePasseValide } = require('./patientes');
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
    grossesse: grossesse ? { numero: grossesse.numero, agJours: grossesse.agJoursLe(), dpa: grossesse.datation?.dpa ?? null } : null,
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

/** Accouchements : résumé (pas de partogramme), sortie, rendez-vous CPoN, conseils et mesures préventives. */
exports.accouchements = async (req, res) => {
  const p = req.patiente;
  const [dossiers, enfants] = await Promise.all([
    Accouchement.find({ patienteId: p._id, accouchement: { $exists: true } }).sort({ 'accouchement.heure': -1 }),
    Enfant.find({ mereId: p._id }).select('prenom sexe neLe etatNaissance accouchementId'),
  ]);
  const libelles = (liste, valeurs) => liste.filter(({ code }) => valeurs?.[code] === true).map(({ libelle }) => libelle);
  await journaliser(req, { action: 'espace.lecture', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'accouchements' } });
  res.json(dossiers.map((a) => {
    const pp = a.postPartum ?? {};
    return {
      id: a.id, numero: a.numero, statut: a.statut,
      date: a.accouchement.heure, mode: a.accouchement.mode, multiple: a.accouchement.multiple,
      accoucheur: a.accouchement.accoucheur,
      enfants: enfants.filter((e) => String(e.accouchementId) === a.id)
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

/**
 * Conseils des médecins : ceux donnés à la patiente (consultations finalisées, sortie de la
 * maternité), puis les articles de conseils approuvés par le médecin chef (lecture seule :
 * ni j'aime ni commentaires, réservés aux soignants).
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
  await journaliser(req, { action: 'espace.lecture', patienteId: p._id, ressource: { type: 'patiente', id: p.numero }, details: { page: 'conseils' } });
  res.json({
    personnels,
    articles: articles.map((a) => ({
      id: a.id, titre: a.titre, contenu: a.contenu, cible: a.cible,
      medias: a.medias.map((m) => ({ type: m.type, url: m.url })),
      auteur: soignant(a.auteur), publieLe: a.createdAt,
    })),
  });
};
