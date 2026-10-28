const bcrypt = require('bcrypt');
const mongoose = require('mongoose');
const Patiente = require('../models/Patiente');
const Grossesse = require('../models/Grossesse');
const Consultation = require('../models/Consultation');
const RendezVous = require('../models/RendezVous');
const Echographie = require('../models/Echographie');
const Accouchement = require('../models/Accouchement');
const Enfant = require('../models/Enfant');
const JournalAudit = require('../models/JournalAudit');
const Etablissement = require('../models/Etablissement');
const { auteurDe } = require('../models/commun');
const { ROLES_MEDECIN } = require('../models/Soignant');
const { journaliser, ACTIONS } = require('../config/audit');
const { PROVINCES_RDC } = require('../config/referentiels');
const cpn = require('../config/cpn');
const { envoyerFichier, supprimerFichier, urlSignee } = require('../config/r2');
const { messageValidation } = require('../config/erreursFr');
const { verifierVersion } = require('../config/conflits');

const DOSSIER_PHOTOS = 'patiente';
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Mot de passe de l'espace patiente : 8 caractères au moins, avec lettres et chiffres. */
function motDePasseValide(m) {
  return typeof m === 'string' && m.length >= 8 && m.length <= 128 && /[A-Za-z]/.test(m) && /\d/.test(m);
}
exports.motDePasseValide = motDePasseValide;

const { calculerDatation } = Grossesse;
const { STATUTS_ACTIFS, CANAUX_RAPPEL } = RendezVous;
const PAR_PAGE_MAX = 50;

/** Erreur HTTP transmise au gestionnaire d'erreurs d'app.js. */
const erreur = (status, message, extra) => Object.assign(new Error(message), { status, ...extra });

/** Valeur texte d'un champ du corps (jamais un objet : protège des injections NoSQL). */
const texte = (v, max = 2000) => (v == null ? '' : String(v).trim().slice(0, max));
const nombre = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const booleen = (v) => (v === true || v === 'true' ? true : v === false || v === 'false' ? false : null);
const echapperRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const listeTextes = (v) => (Array.isArray(v) ? v.map((x) => texte(x, 200)).filter(Boolean).slice(0, 30) : []);
/** Valeur d'un référentiel ('' si absente ou inconnue). */
const choix = (v, valeurs) => (valeurs.includes(v) ? v : '');
/** Cases cochées : seules les valeurs du référentiel sont retenues, sans doublon. */
const cases = (v, valeurs) => (Array.isArray(v) ? [...new Set(v.filter((x) => valeurs.includes(x)))] : []);

/** Patiente par identifiant AC-PAT-… ou identifiant MongoDB. */
async function trouverPatiente(id) {
  const p = /^AC-PAT-\d+$/.test(id) ? await Patiente.findOne({ numero: id })
    : mongoose.isValidObjectId(id) ? await Patiente.findById(id) : null;
  if (!p) throw erreur(404, 'Dossier patiente introuvable.');
  return p;
}
exports.trouverPatiente = trouverPatiente;

/** Champs administratifs acceptés depuis le formulaire (liste blanche). */
function champsAdministratifs(d = {}) {
  const c = {};
  for (const k of ['nom', 'postnom', 'prenom', 'pieceIdentite', 'telephone', 'telephone2', 'occupation', 'nomPartenaire', 'occupationPartenaire']) if (d[k] !== undefined) c[k] = texte(d[k], 120);
  if (d.etatCivil !== undefined) c.etatCivil = choix(d.etatCivil, cpn.ETATS_CIVILS);
  if (d.groupeSanguin !== undefined) c.groupeSanguin = choix(d.groupeSanguin, cpn.GROUPES_SANGUINS);
  if (d.rhesus !== undefined) c.rhesus = choix(d.rhesus, cpn.RHESUS);
  if (d.electrophoreseHb !== undefined) c.electrophoreseHb = choix(d.electrophoreseHb, cpn.ELECTROPHORESES);
  if (d.tailleCm !== undefined) c.tailleCm = nombre(d.tailleCm);
  if (d.dateNaissance !== undefined) c.dateNaissance = texte(d.dateNaissance, 10) || null;
  if (d.ageDeclare !== undefined) c.ageDeclare = nombre(d.ageDeclare);
  if (d.telephonePartage !== undefined) c.telephonePartage = !!booleen(d.telephonePartage);
  if (d.email !== undefined) c.email = texte(d.email, 200).toLowerCase() || undefined;
  if (d.contactUrgence && typeof d.contactUrgence === 'object') {
    c.contactUrgence = {
      nom: texte(d.contactUrgence.nom, 120), lien: texte(d.contactUrgence.lien, 60),
      telephone: texte(d.contactUrgence.telephone, 40), adresse: texte(d.contactUrgence.adresse, 300),
    };
  }
  if (d.adresse && typeof d.adresse === 'object') {
    c.adresse = {};
    for (const k of ['province', 'commune', 'quartier', 'avenue', 'repere', 'aireSante']) c.adresse[k] = texte(d.adresse[k], 300);
  }
  if (d.antecedents && typeof d.antecedents === 'object') {
    const a = d.antecedents;
    c.antecedents = {};
    for (const k of ['gestite', 'parite', 'enfantsVivants', 'avortements', 'cesariennes']) c.antecedents[k] = nombre(a[k]);
    for (const k of ['complicationsObstetricales', 'medicaux', 'chirurgicaux', 'allergies', 'medicaments']) c.antecedents[k] = texte(a[k]);
    c.antecedents.atcdMedicaux = cases(a.atcdMedicaux, cpn.ATCD_MEDICAUX);
    c.antecedents.atcdGynecoChirurgicaux = cases(a.atcdGynecoChirurgicaux, cpn.ATCD_GYNECO_CHIRURGICAUX);
    c.antecedents.atcdObstetricaux = cases(a.atcdObstetricaux, cpn.ATCD_OBSTETRICAUX);
    c.antecedents.plusGrosPoidsNaissanceG = nombre(a.plusGrosPoidsNaissanceG);
    c.antecedents.dernierAccouchement = texte(a.dernierAccouchement, 10) || null;
    c.antecedents.testVihConnuLe = texte(a.testVihConnuLe, 10) || null;
  }
  return c;
}

function consentementsDe(d, soignant) {
  if (!d || typeof d !== 'object') return undefined;
  return {
    sms: booleen(d.sms), appel: booleen(d.appel), whatsapp: booleen(d.whatsapp),
    version: texte(d.version, 20) || 'v1.2', recueilliLe: new Date(), recueilliPar: auteurDe(soignant),
  };
}

/** Résumé minimal d'une patiente pour les listes (pas de données cliniques détaillées). */
function resume(p, grossesse, prochainRdv, photoUrl) {
  const ag = grossesse?.agJoursLe();
  return {
    photoUrl: photoUrl ?? null,
    id: p.id, numero: p.numero, nom: p.nom, postnom: p.postnom, prenom: p.prenom,
    age: p.age(), dateNaissance: p.dateNaissance, telephoneMasque: p.telephoneMasque(),
    province: p.adresse?.province ?? '', commune: p.adresse?.commune ?? '', quartier: p.adresse?.quartier ?? '',
    statut: p.statut, creeLe: p.createdAt,
    grossesse: grossesse ? {
      id: grossesse.id, statut: grossesse.statut, agJours: ag, dpa: grossesse.datation?.dpa ?? null,
      aRisque: grossesse.facteursRisque.length > 0,
    } : null,
    prochainRdv: prochainRdv ? { id: prochainRdv.id, date: prochainRdv.date, motif: prochainRdv.motif } : null,
  };
}

/** Grossesse la plus récente et prochain rendez-vous attendu de chaque patiente. */
async function completer(patientes) {
  const ids = patientes.map((p) => p._id);
  const [grossesses, rdvs] = await Promise.all([
    Grossesse.find({ patienteId: { $in: ids } }).sort({ numero: -1 }),
    RendezVous.find({ patienteId: { $in: ids }, statut: { $in: STATUTS_ACTIFS }, date: { $gte: debutDuJour() } }).sort({ date: 1 }),
  ]);
  // Liens signés calculés localement (aucun appel réseau), valables 15 minutes.
  const photos = await Promise.all(patientes.map((p) => urlSignee(p.photoCle)));
  return patientes.map((p, i) => resume(
    p,
    grossesses.find((g) => g.patienteId.equals(p._id)),
    rdvs.find((r) => r.patienteId.equals(p._id)),
    photos[i],
  ));
}

function debutDuJour() {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

/** Recherche paginée : identifiant, nom, postnom, prénom ou téléphone. */
exports.rechercher = async (req, res) => {
  const q = texte(req.query.q, 100);
  const page = Math.max(1, parseInt(req.query.page, 10) || 1);
  const parPage = Math.min(PAR_PAGE_MAX, Math.max(1, parseInt(req.query.parPage, 10) || 20));
  const filtre = {};
  if (req.query.statut && Patiente.STATUTS_PATIENTE.includes(req.query.statut)) filtre.statut = req.query.statut;
  if (req.query.province && PROVINCES_RDC.includes(req.query.province)) filtre['adresse.province'] = req.query.province;
  if (q) {
    // Chaque mot doit figurer dans l'identifiant, le nom, le postnom ou le prénom…
    const mots = q.split(/\s+/).filter(Boolean).slice(0, 4).map((m) => new RegExp(echapperRegex(m), 'i'));
    const parIdentite = { $and: mots.map((r) => ({ $or: [{ numero: r }, { nom: r }, { postnom: r }, { prenom: r }] })) };
    // …ou la recherche est un numéro de téléphone (au moins 4 chiffres).
    const chiffres = q.replace(/\D/g, '');
    filtre.$or = chiffres.length >= 4 && chiffres.length === q.replace(/[\s+().-]/g, '').length
      ? [{ telephoneChiffres: new RegExp(chiffres.slice(-9)) }, { telephone2Chiffres: new RegExp(chiffres.slice(-9)) }]
      : [parIdentite];
  }
  const [total, patientes] = await Promise.all([
    Patiente.countDocuments(filtre),
    Patiente.find(filtre).sort({ updatedAt: -1 }).skip((page - 1) * parPage).limit(parPage),
  ]);
  await journaliser(req, { action: 'patiente.recherche', details: { resultats: total } });
  const resultats = await completer(patientes);
  // Infirmier·ères : pas d'indication de risque (donnée clinique réservée aux médecins).
  if (!ROLES_MEDECIN.includes(req.soignant.role)) resultats.forEach((r) => r.grossesse && delete r.grossesse.aRisque);
  res.json({ total, page, parPage, resultats });
};

/** Doublons possibles : même identité (nom + prénom/date de naissance) ou même téléphone. */
async function chercherDoublons({ nom, prenom, dateNaissance, telephone }, exclureId) {
  const ou = [];
  if (nom) {
    const memeNom = { nom: new RegExp(`^${echapperRegex(nom)}$`, 'i') };
    if (prenom) ou.push({ ...memeNom, prenom: new RegExp(`^${echapperRegex(prenom)}$`, 'i') });
    if (dateNaissance) ou.push({ ...memeNom, dateNaissance });
  }
  const chiffres = String(telephone || '').replace(/\D/g, '');
  if (chiffres.length >= 9) ou.push({ telephoneChiffres: new RegExp(`${chiffres.slice(-9)}$`) });
  if (!ou.length) return [];
  const filtre = { $or: ou, ...(exclureId ? { _id: { $ne: exclureId } } : {}) };
  const trouves = await Patiente.find(filtre).limit(5);
  return trouves.map((p) => ({
    id: p.id, numero: p.numero, nom: p.nom, postnom: p.postnom, prenom: p.prenom,
    age: p.age(), telephoneMasque: p.telephoneMasque(), commune: p.adresse?.commune ?? '',
  }));
}
exports.chercherDoublons = chercherDoublons;
exports.champsAdministratifs = champsAdministratifs;

exports.doublons = async (req, res) => {
  res.json(await chercherDoublons({
    nom: texte(req.query.nom, 120), prenom: texte(req.query.prenom, 120),
    dateNaissance: texte(req.query.dateNaissance, 10), telephone: texte(req.query.telephone, 40),
  }));
};

/** Datation saisie dans le formulaire → datation validée par le médecin connecté. */
function datationDepuis(d, soignant) {
  if (!d || typeof d !== 'object' || !d.methode) return undefined;
  if (!Grossesse.METHODES_DATATION.includes(d.methode)) throw erreur(400, 'Méthode de datation inconnue.');
  return {
    ...calculerDatation({
      methode: d.methode, ddr: texte(d.ddr, 10) || null, ddrFiabilite: texte(d.ddrFiabilite, 20) || null,
      dateReference: texte(d.dateReference, 10) || null, agSemaines: nombre(d.agSemaines), agJours: nombre(d.agJours),
      dpa: texte(d.dpa, 10) || null, justification: texte(d.justification, 500),
    }),
    valideePar: auteurDe(soignant),
    valideeLe: new Date(),
  };
}

/**
 * Enregistrement : dossier patiente + grossesse en cours (+ premier rendez-vous facultatif).
 * Les doublons possibles sont signalés (409) tant que le médecin ne confirme pas.
 * La première consultation est ensuite réalisée depuis le dossier.
 */
exports.creer = async (req, res) => {
  // Formulaire multipart : les données arrivent en JSON dans « donnees », la photo dans « photo ».
  let d;
  try {
    d = typeof req.body?.donnees === 'string' ? JSON.parse(req.body.donnees) : req.body || {};
  } catch {
    throw erreur(400, 'Données du formulaire invalides.');
  }
  const champs = champsAdministratifs(d.patiente);
  if (!req.file) throw erreur(400, 'La photo de la patiente est obligatoire.');
  if (!champs.nom) throw erreur(400, 'Le nom est obligatoire.');
  if (!champs.dateNaissance && champs.ageDeclare == null) throw erreur(400, 'Date de naissance ou âge déclaré obligatoire.');
  if (!PROVINCES_RDC.includes(champs.adresse?.province)) throw erreur(400, 'Choisissez la province de résidence parmi les 26 provinces de la RDC.');
  // Espace patiente (application mobile) : e-mail et mot de passe choisis par la patiente, obligatoires.
  if (!champs.email || !EMAIL.test(champs.email)) throw erreur(400, 'Adresse e-mail de la patiente obligatoire et valide.');
  const motDePasse = d.compte?.motDePasse;
  if (!motDePasseValide(motDePasse)) throw erreur(400, 'Mot de passe de la patiente trop faible : 8 caractères au moins, avec des lettres et des chiffres.');
  const memeEmail = await Patiente.findOne({ email: champs.email });
  if (memeEmail) {
    return res.status(409).json({
      message: `Cette patiente est déjà inscrite (dossier ${memeEmail.numero}). Pour une nouvelle grossesse, ouvrez son dossier : elle garde le même compte et tout son historique.`,
      emailExistant: true,
      doublons: [{
        id: memeEmail.id, numero: memeEmail.numero, nom: memeEmail.nom, postnom: memeEmail.postnom, prenom: memeEmail.prenom,
        age: memeEmail.age(), telephoneMasque: memeEmail.telephoneMasque(), commune: memeEmail.adresse?.commune ?? '',
      }],
    });
  }

  // Établissement de prise en charge : choisi dans le formulaire (actif), sinon celui de la connexion.
  const etablissementId = d.etablissementId ? String(d.etablissementId) : req.etablissementId;
  if (!etablissementId) throw erreur(400, 'Choisissez l’établissement sanitaire de prise en charge.');
  const [etablissement] = await Etablissement.actifsParIds([etablissementId]);
  if (!etablissement) throw erreur(400, 'Établissement sanitaire inexistant ou suspendu.');

  const doublons = await chercherDoublons(champs);
  if (doublons.length && d.confirmerMalgreDoublons !== true) {
    return res.status(409).json({ message: 'Dossier(s) existant(s) possiblement identique(s) : si c’est la même patiente, ouvrez son dossier et déclarez une nouvelle grossesse.', doublons });
  }

  const auteur = auteurDe(req.soignant);
  const patiente = new Patiente({
    ...champs,
    ageDeclareLe: champs.ageDeclare != null ? new Date().toISOString().slice(0, 10) : null,
    consentements: consentementsDe(d.patiente?.consentements, req.soignant),
    etablissementId: etablissement.id,
    motDePasse: await bcrypt.hash(motDePasse, 12),
    espaceEnLigne: 'Activé',
    creePar: auteur,
    numero: await Patiente.prochainNumero(),
  });
  const grossesse = new Grossesse({
    patienteId: patiente._id,
    numero: 1,
    grossesseMultiple: booleen(d.grossesse?.grossesseMultiple),
    facteursRisque: listeTextes(d.grossesse?.facteursRisque),
    datation: datationDepuis(d.grossesse?.datation, req.soignant),
    creePar: auteur,
  });
  let rdv = null;
  if (d.rendezVous?.date) {
    rdv = new RendezVous({
      patienteId: patiente._id, grossesseId: grossesse._id, date: new Date(d.rendezVous.date),
      motif: texte(d.rendezVous.motif, 200) || 'Consultation prénatale', etablissementId: etablissement.id,
      lieu: texte(d.rendezVous.lieu, 200), consignes: texte(d.rendezVous.consignes, 500),
      canalRappel: CANAUX_RAPPEL.includes(d.rendezVous.canalRappel) ? d.rendezVous.canalRappel : 'Aucun',
      creePar: auteur, historique: [{ action: 'Planifié', nouvelleDate: new Date(d.rendezVous.date), nouveauStatut: 'Planifié', par: auteur, le: new Date() }],
    });
    if (Number.isNaN(rdv.date.getTime())) throw erreur(400, 'Date de rendez-vous invalide.');
  }

  // Première CPN saisie avec le dossier : contrôlée maintenant, enregistrée après la patiente.
  // (chargé ici : controllers/consultations dépend de ce fichier)
  const consultations = require('./consultations');
  const premiereCpn = d.premiereConsultation && typeof d.premiereConsultation === 'object'
    ? consultations.champsPremiereCpn(d.premiereConsultation) : null;

  try {
    await Promise.all([patiente.validate(), grossesse.validate(), rdv?.validate()]);
  } catch (err) {
    throw erreur(400, messageValidation(err));
  }

  // Photo envoyée après toutes les validations, pour ne pas laisser de fichier orphelin.
  patiente.photoCle = (await envoyerFichier(req.file, DOSSIER_PHOTOS)).cle;

  // Sans transaction (MongoDB autonome) : en cas d'échec, les documents déjà créés sont retirés.
  try {
    await patiente.save();
    await grossesse.save();
    if (rdv) await rdv.save();
  } catch (err) {
    await Promise.all([Grossesse.deleteOne({ _id: grossesse._id }), Patiente.deleteOne({ _id: patiente._id })]).catch(() => {});
    await supprimerFichier(patiente.photoCle).catch(() => {});
    if (err.code === 11000) throw erreur(409, 'Identifiant ou e-mail déjà utilisé, réessayez.');
    throw err;
  }

  await journaliser(req, { action: 'patiente.creation', patienteId: patiente._id, ressource: { type: 'patiente', id: patiente.numero } });
  if (grossesse.datation) await journaliser(req, { action: 'grossesse.datation', patienteId: patiente._id, ressource: { type: 'grossesse', id: grossesse.id }, details: { methode: grossesse.datation.methode } });
  if (rdv) await journaliser(req, { action: 'rdv.creation', patienteId: patiente._id, ressource: { type: 'rendezvous', id: rdv.id } });
  const consultation = premiereCpn ? await consultations.creerBrouillon(grossesse, premiereCpn, req) : null;
  res.status(201).json({ id: patiente.id, numero: patiente.numero, grossesseId: grossesse.id, consultationId: consultation?.id ?? null });
};

/** Médecin de la première consultation : type « Première consultation prénatale », sinon la plus ancienne finalisée. */
function premiereConsultation(consultations) {
  const finalisees = consultations.filter((c) => c.statut === 'Finalisée').sort((a, b) => a.date - b.date);
  const c = finalisees.find((x) => x.type === 'Première consultation prénatale') ?? finalisees[0];
  return c ? { consultationId: c.id, medecin: c.auteur, date: c.date, etablissementId: c.etablissementId } : null;
}

/**
 * Mesures préventives réalisées pendant une grossesse (consultations finalisées) :
 * { code: { date, valeur, consultationId } } — la plus récente réponse « oui » de chaque mesure.
 */
function mesuresRealisees(consultations) {
  const faites = {};
  const finalisees = consultations.filter((c) => c.statut === 'Finalisée').sort((a, b) => a.date - b.date);
  for (const c of finalisees) {
    for (const { code } of cpn.MESURES_PREVENTIVES) {
      const m = c.mesuresPreventives?.[code];
      if (m?.reponse === true) faites[code] = { date: c.date, valeur: m.valeur || faites[code]?.valeur || '', consultationId: c.id };
    }
  }
  return faites;
}

/** Dossier complet : chaque ouverture est journalisée (distincte d'une consultation réalisée). */
exports.dossier = async (req, res) => {
  const patiente = await trouverPatiente(req.params.id);
  const [grossesses, consultations, rendezVous, echographies, accouchements, enfants] = await Promise.all([
    Grossesse.find({ patienteId: patiente._id }).sort({ numero: -1 }),
    Consultation.find({ patienteId: patiente._id }).sort({ date: -1 }),
    RendezVous.find({ patienteId: patiente._id }).sort({ date: -1 }),
    Echographie.find({ patienteId: patiente._id }).sort({ date: -1, createdAt: -1 }),
    Accouchement.find({ patienteId: patiente._id }).sort({ 'admission.admiseLe': -1 }).select('numero grossesseId statut admission.admiseLe accouchement.heure accouchement.mode'),
    Enfant.find({ mereId: patiente._id }).sort({ neLe: -1 }),
  ]);
  const [etablissement] = patiente.etablissementId ? await Etablissement.actifsParIds([patiente.etablissementId]) : [];
  await journaliser(req, { action: 'dossier.lecture', patienteId: patiente._id, ressource: { type: 'patiente', id: patiente.numero } });
  res.json({
    etablissement: etablissement ? { id: etablissement.id, code: etablissement.code, nom: etablissement.nom, province: etablissement.province } : null,
    patiente: { ...patiente.toJSON(), age: patiente.age(), photoUrl: await urlSignee(patiente.photoCle) },
    grossesses: grossesses.map((g) => ({
      ...g.toJSON(),
      agJours: g.statut === 'En cours' ? g.agJoursLe() : null,
      mesuresPreventives: mesuresRealisees(consultations.filter((c) => c.grossesseId.equals(g._id))),
    })),
    // Liste de l'historique : résumé seulement, le détail s'ouvre (et se journalise) séparément.
    consultations: consultations.map((c) => ({
      id: c.id, grossesseId: c.grossesseId, type: c.type, date: c.date, auteur: c.auteur, statut: c.statut,
      agJours: c.agJours, motif: c.motif, finaliseeLe: c.finaliseeLe, addenda: c.addenda.length,
      constantes: c.constantes, createdAt: c.createdAt,
      reference: c.reference?.le ? { le: c.reference.le, motifs: c.reference.motifs } : null,
    })),
    rendezVous,
    echographies: await Promise.all(echographies.map((e) => e.vue())),
    premiereConsultation: premiereConsultation(consultations),
    accouchements: accouchements.map((a) => ({
      id: a.id, numero: a.numero, grossesseId: a.grossesseId, statut: a.statut, admiseLe: a.admission.admiseLe,
      accoucheeLe: a.accouchement?.heure ?? null, mode: a.accouchement?.mode ?? null,
    })),
    // Chargé à l'appel (controllers/enfants dépend de ce module).
    enfants: await Promise.all(enfants.map(require('./enfants').resumeAvecPhoto)),
  });
};

/** Mise à jour des informations administratives ; les champs modifiés (sans valeurs) sont journalisés. */
exports.modifier = async (req, res) => {
  const patiente = await trouverPatiente(req.params.id);
  verifierVersion(req, patiente, 'le dossier de la patiente');
  const champs = champsAdministratifs(req.body);
  if (req.body?.consentements) champs.consentements = consentementsDe(req.body.consentements, req.soignant);
  if (req.body?.statut !== undefined) {
    if (!Patiente.STATUTS_PATIENTE.includes(req.body.statut)) throw erreur(400, 'Statut inconnu.');
    champs.statut = req.body.statut;
  }
  // L'e-mail est l'identifiant de l'espace patiente : il ne peut pas être effacé.
  if ('email' in champs && (!champs.email || !EMAIL.test(champs.email))) {
    if (patiente.email || champs.email) throw erreur(400, 'Adresse e-mail de la patiente obligatoire et valide.');
    delete champs.email;
  }
  if (champs.email && champs.email !== patiente.email && await Patiente.exists({ email: champs.email, _id: { $ne: patiente._id } })) {
    throw erreur(409, 'Cette adresse e-mail est déjà liée à un autre dossier.');
  }
  patiente.set(champs);
  const modifies = patiente.modifiedPaths().filter((p) => !p.includes('.'));
  if (!modifies.length) return res.json({ ...patiente.toJSON(), age: patiente.age() });
  patiente.modifiePar = auteurDe(req.soignant);
  try {
    await patiente.save();
  } catch (err) {
    if (err.errors) throw erreur(400, messageValidation(err));
    throw err;
  }
  await journaliser(req, { action: 'patiente.modification', patienteId: patiente._id, ressource: { type: 'patiente', id: patiente.numero }, details: { champs: modifies } });
  res.json({ ...patiente.toJSON(), age: patiente.age() });
};

/** Nouvelle grossesse (la précédente doit être terminée). */
exports.nouvelleGrossesse = async (req, res) => {
  const patiente = await trouverPatiente(req.params.id);
  if (await Grossesse.exists({ patienteId: patiente._id, statut: 'En cours' })) {
    throw erreur(409, 'Une grossesse est déjà en cours pour cette patiente : enregistrez d’abord son issue (accouchement, fausse couche…).');
  }
  const derniere = await Grossesse.findOne({ patienteId: patiente._id }).sort({ numero: -1 });
  const grossesse = await Grossesse.create({
    patienteId: patiente._id,
    numero: (derniere?.numero ?? 0) + 1,
    grossesseMultiple: booleen(req.body?.grossesseMultiple),
    facteursRisque: listeTextes(req.body?.facteursRisque),
    datation: datationDepuis(req.body?.datation, req.soignant),
    creePar: auteurDe(req.soignant),
  });
  patiente.statut = 'Suivi prénatal';
  await patiente.save();
  await journaliser(req, { action: 'grossesse.creation', patienteId: patiente._id, ressource: { type: 'grossesse', id: grossesse.id } });
  res.status(201).json(grossesse);
};

async function trouverGrossesse(id) {
  const g = mongoose.isValidObjectId(id) && await Grossesse.findById(id);
  if (!g) throw erreur(404, 'Grossesse introuvable.');
  return g;
}
exports.trouverGrossesse = trouverGrossesse;

/** Nouvelle datation validée : l'ancienne est conservée dans l'historique. */
exports.dater = async (req, res) => {
  const g = await trouverGrossesse(req.params.id);
  if (g.statut !== 'En cours') throw erreur(400, 'Cette grossesse est terminée.');
  const nouvelle = datationDepuis(req.body, req.soignant);
  if (!nouvelle) throw erreur(400, 'Méthode de datation requise.');
  if (g.datation) {
    if (!texte(req.body.justification)) throw erreur(400, 'Indiquez le motif de la nouvelle datation.');
    g.historiqueDatation.push(g.datation);
  }
  g.datation = nouvelle;
  await g.save();
  await journaliser(req, { action: 'grossesse.datation', patienteId: g.patienteId, ressource: { type: 'grossesse', id: g.id }, details: { methode: nouvelle.methode } });
  res.json({ ...g.toJSON(), agJours: g.agJoursLe() });
};

/** Facteurs de risque et grossesse multiple (relevés par le médecin). */
exports.modifierGrossesse = async (req, res) => {
  const g = await trouverGrossesse(req.params.id);
  if (req.body?.facteursRisque !== undefined) g.facteursRisque = listeTextes(req.body.facteursRisque);
  if (req.body?.grossesseMultiple !== undefined) g.grossesseMultiple = booleen(req.body.grossesseMultiple);
  await g.save();
  await journaliser(req, { action: 'grossesse.datation', patienteId: g.patienteId, ressource: { type: 'grossesse', id: g.id }, details: { champs: ['facteursRisque', 'grossesseMultiple'] } });
  res.json({ ...g.toJSON(), agJours: g.agJoursLe() });
};

/** Issue de grossesse (accouchement…) : la grossesse est close, le dossier passe en suivi postnatal. */
exports.issue = async (req, res) => {
  const g = await trouverGrossesse(req.params.id);
  if (g.statut !== 'En cours') throw erreur(400, 'L’issue de cette grossesse est déjà enregistrée.');
  const d = req.body || {};
  if (!Grossesse.ISSUES.includes(d.issue)) throw erreur(400, 'Issue de grossesse requise.');
  g.issue = {
    date: texte(d.date, 10), lieu: texte(d.lieu, 200), issue: d.issue,
    mode: Grossesse.MODES_ACCOUCHEMENT.includes(d.mode) ? d.mode : 'Non applicable',
    complications: texte(d.complications), resume: texte(d.resume), orientation: texte(d.orientation),
    enregistreePar: auteurDe(req.soignant), enregistreeLe: new Date(),
  };
  g.statut = 'Terminée';
  try {
    await g.save();
  } catch (err) {
    if (err.errors) throw erreur(400, messageValidation(err));
    throw err;
  }
  await Patiente.updateOne({ _id: g.patienteId }, { statut: 'Suivi postnatal' });
  await journaliser(req, { action: 'grossesse.issue', patienteId: g.patienteId, ressource: { type: 'grossesse', id: g.id }, details: { issue: d.issue } });
  res.json(g);
};

/** Historique d'audit du dossier (ouvertures, actes, refus), du plus récent au plus ancien. */
exports.journal = async (req, res) => {
  const patiente = await trouverPatiente(req.params.id);
  const entrees = await JournalAudit.find({ patienteId: patiente._id }).sort({ le: -1 }).limit(300);
  res.json(entrees.map((e) => ({ ...e.toJSON(), libelle: ACTIONS[e.action] ?? e.action })));
};

/**
 * Suppression définitive d'un dossier (médecin chef) : patiente, grossesses, consultations,
 * rendez-vous, accouchements, dossiers de ses enfants et photo. Le numéro du dossier doit être retapé. Le journal d'audit, lui, est
 * conservé (ajout seul) avec une entrée de suppression, sans donnée clinique.
 */
exports.supprimer = async (req, res) => {
  const patiente = await trouverPatiente(req.params.id);
  if (texte(req.body?.confirmation, 30) !== patiente.numero) {
    throw erreur(400, `Saisissez le numéro du dossier (${patiente.numero}) pour confirmer la suppression.`);
  }
  const echographies = await Echographie.find({ patienteId: patiente._id }).select('fichiers');
  const photosEnfants = (await Enfant.find({ mereId: patiente._id }).select('photoCle')).map((e) => e.photoCle);
  const [consultations, grossesses, rendezVous, , accouchements, enfants] = await Promise.all([
    Consultation.deleteMany({ patienteId: patiente._id }),
    Grossesse.deleteMany({ patienteId: patiente._id }),
    RendezVous.deleteMany({ patienteId: patiente._id }),
    Echographie.deleteMany({ patienteId: patiente._id }),
    Accouchement.deleteMany({ patienteId: patiente._id }),
    Enfant.deleteMany({ mereId: patiente._id }),
  ]);
  await patiente.deleteOne();
  // Photo, comptes rendus et images d'échographie : retirés du bucket avec le dossier.
  const cles = [patiente.photoCle, ...photosEnfants, ...echographies.flatMap((e) => e.fichiers.map((f) => f.cle))].filter(Boolean);
  await Promise.all(cles.map((cle) => supprimerFichier(cle).catch((err) => console.error(`Fichier ${cle} non supprimé de R2 :`, err.message))));
  await journaliser(req, {
    action: 'patiente.suppression', patienteId: patiente._id, ressource: { type: 'patiente', id: patiente.numero },
    details: {
      consultations: consultations.deletedCount, grossesses: grossesses.deletedCount, rendezVous: rendezVous.deletedCount,
      accouchements: accouchements.deletedCount, enfants: enfants.deletedCount,
    },
  });
  res.status(204).end();
};

/**
 * Vue « suivi » ouverte à tout le personnel soignant (infirmier·ères compris) : identité,
 * grossesse en cours (n°, âge gestationnel, DPA) et rendez-vous. Aucune donnée sensible :
 * ni antécédents, ni facteurs de risque, ni consultations, ni datation détaillée, ni journal.
 */
exports.suivi = async (req, res) => {
  const patiente = await trouverPatiente(req.params.id);
  const [grossesse, rendezVous, visites, photoUrl, enfants] = await Promise.all([
    Grossesse.findOne({ patienteId: patiente._id, statut: 'En cours' }).sort({ numero: -1 }),
    RendezVous.find({ patienteId: patiente._id }).sort({ date: -1 }),
    // Historique des visites : date, type et soignant seulement (ni motif, ni constantes, ni examen).
    Consultation.find({ patienteId: patiente._id, statut: { $ne: 'Annulée' } }).sort({ date: -1 }).select('type date statut auteur'),
    urlSignee(patiente.photoCle),
    Enfant.find({ mereId: patiente._id }).sort({ neLe: -1 }),
  ]);
  const a = patiente.adresse ?? {};
  const urgence = patiente.contactUrgence ?? {};
  const [etablissement] = patiente.etablissementId ? await Etablissement.actifsParIds([patiente.etablissementId]) : [];
  await journaliser(req, { action: 'suivi.lecture', patienteId: patiente._id, ressource: { type: 'patiente', id: patiente.numero } });
  res.json({
    // Informations administratives uniquement : aucun antécédent, profil biologique ni donnée clinique.
    patiente: {
      id: patiente.id, numero: patiente.numero, nom: patiente.nom, postnom: patiente.postnom, prenom: patiente.prenom,
      age: patiente.age(), dateNaissance: patiente.dateNaissance ?? null, photoUrl, statut: patiente.statut,
      etatCivil: patiente.etatCivil, occupation: patiente.occupation, nomPartenaire: patiente.nomPartenaire,
      telephone: patiente.telephone, telephone2: patiente.telephone2,
      province: a.province ?? '', commune: a.commune ?? '', quartier: a.quartier ?? '', avenue: a.avenue ?? '',
      repere: a.repere ?? '', aireSante: a.aireSante ?? '',
      contactUrgence: { nom: urgence.nom ?? '', lien: urgence.lien ?? '', telephone: urgence.telephone ?? '' },
    },
    etablissement: etablissement ? { id: etablissement.id, nom: etablissement.nom, province: etablissement.province } : null,
    grossesse: grossesse ? {
      id: grossesse.id, numero: grossesse.numero, statut: grossesse.statut,
      agJours: grossesse.agJoursLe(), dpa: grossesse.datation?.dpa ?? null, datee: !!grossesse.datation,
    } : null,
    // Enfants : identité et vaccination (le carnet complet s'ouvre via /api/enfants/:id).
    enfants: await Promise.all(enfants.map(require('./enfants').resumeAvecPhoto)),
    rendezVous: rendezVous.map((r) => ({
      id: r.id, date: r.date, motif: r.motif, lieu: r.lieu, consignes: r.consignes, statut: r.statut, enfantId: r.enfantId,
      historique: r.historique.map((h) => ({ action: h.action, ancienneDate: h.ancienneDate, nouvelleDate: h.nouvelleDate, motif: h.motif, le: h.le })),
    })),
    visites: visites.map((c) => ({ id: c.id, date: c.date, type: c.type, statut: c.statut, soignant: { nom: c.auteur.nom, role: c.auteur.role } })),
  });
};
