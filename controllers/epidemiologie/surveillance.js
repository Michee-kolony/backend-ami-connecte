// Sous-fenêtre 5 — Surveillance épidémiologique : notification des événements, enregistrement des
// cas (suspects, probables, confirmés), investigation, suivi, clôture, tableaux et courbe épidémique.
// AMI ne remplace pas les circuits officiels de notification (SIMR) : il facilite leur application
// et leur traçabilité. Une notification n'est pas un cas confirmé.
const mongoose = require('mongoose');
const EvenementSanitaire = require('../../models/EvenementSanitaire');
const CasSurveillance = require('../../models/CasSurveillance');
const EntiteGeographique = require('../../models/EntiteGeographique');
const Patiente = require('../../models/Patiente');
const Enfant = require('../../models/Enfant');
const { enregistrerNumerote } = require('../../models/validationEpi');
const epi = require('../../config/epidemiologie');
const { ratio, variation } = require('../../config/moteurEpidemiologie');
const { erreur, texte, objet, jour } = require('../saisie');
const c = require('./commun');

const JOUR = 86400000;
const libelleMaladie = (code) => epi.PAR_MALADIE.get(code)?.libelle ?? code;
const entier = (v, libelle) => {
  const n = Number(v);
  if (v === '' || v == null || !Number.isInteger(n) || n < 0) throw erreur(400, `${libelle} : nombre entier positif attendu.`);
  return n;
};
const entierOuNull = (v, libelle) => (v === '' || v == null ? null : entier(v, libelle));
const choix = (v, liste, libelle, requis = true) => {
  if ((v === '' || v == null) && !requis) return undefined;
  if (!liste.includes(v)) throw erreur(400, `${libelle} invalide.`);
  return v;
};
const pasFutur = (j, libelle) => {
  if (j && j > new Date(Date.now() + 3600000).toISOString().slice(0, 10)) throw erreur(400, `${libelle} ne peut pas être dans le futur.`);
  return j;
};

/** Semaine épidémiologique ISO (AAAA-Sxx) d'un jour AAAA-MM-JJ. */
function semaineEpi(jourIso) {
  const d = new Date(`${jourIso}T00:00:00Z`);
  const j = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - j);
  const debut = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return `${d.getUTCFullYear()}-S${String(Math.ceil(((d - debut) / JOUR + 1) / 7)).padStart(2, '0')}`;
}
exports.semaineEpi = semaineEpi;

/** Filtre territoire (entité et descendants) et période sur un champ jour. */
async function filtreBase(q, champJour) {
  const f = {};
  if (q.dans) f.entiteCode = { $in: (await c.descendants(texte(q.dans, 80).toUpperCase())).map((e) => e.code) };
  if (q.du || q.au || q.mois || q.annee || q.trimestre) {
    const p = c.periode(q);
    f[champJour] = { $gte: p.du, $lte: p.au };
  }
  return f;
}

// --- Formulaire A : notification ---------------------------------------------------------------

function lireEvenement(d, partiel = false) {
  const o = {};
  const p = (k) => !partiel || d[k] !== undefined;
  if (p('type')) o.type = choix(d.type, epi.TYPES_EVENEMENT, 'Type d’événement');
  if (p('maladie')) { if (!epi.PAR_MALADIE.has(d.maladie)) throw erreur(400, 'Maladie ou événement invalide.'); o.maladie = d.maladie; }
  if (d.dateDebut !== undefined) o.dateDebut = pasFutur(jour(d.dateDebut, 'Date de début'), 'La date de début');
  if (p('casSignales')) o.casSignales = entier(d.casSignales, 'Nombre de cas signalés');
  if (p('decesSignales')) o.decesSignales = entier(d.decesSignales, 'Nombre de décès signalés');
  if (o.decesSignales > o.casSignales) throw erreur(400, 'Le nombre de décès ne peut pas dépasser le nombre de cas signalés.');
  if (p('description')) { o.description = texte(d.description, 4000); if (!o.description) throw erreur(400, 'La description de l’événement est obligatoire.'); }
  if (p('priorite')) o.priorite = choix(d.priorite, epi.PRIORITES, 'Priorité initiale');
  if (d.document !== undefined) o.document = texte(d.document, 500);
  return o;
}

exports.notifier = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Notification réservée au personnel habilité.');
  const d = objet(req.body);
  const e = await c.entite(d.entiteCode);
  if (['Pays', 'Province'].includes(e.niveau)) throw erreur(400, 'Localisez l’événement au moins au niveau de la zone de santé.');
  const ev = new EvenementSanitaire({
    ...lireEvenement(d), entiteCode: e.code, etablissementId: req.etablissementId ?? null, dateNotification: new Date(),
    creePar: c.auteur(req), statut: 'Soumis', soumission: { par: c.auteur(req), le: new Date() },
  });
  ev.tracer('Notification', c.auteur(req));
  await ev.validate({ pathsToSkip: ['numero'] }).catch((err) => { throw erreur(400, require('../../config/erreursFr').messageValidation(err)); });
  await enregistrerNumerote(ev, `EVT-${new Date().getFullYear()}`);
  await c.tracer(req, 'epi.evenement', { type: 'evenement', id: ev.numero }, { operation: 'notification', maladie: ev.maladie, priorite: ev.priorite });
  res.status(201).json(await vueEvenement(ev));
};

async function trouverEvenement(id) {
  const ev = mongoose.isValidObjectId(id) ? await EvenementSanitaire.findById(id) : await EvenementSanitaire.findOne({ numero: texte(id, 30) });
  if (!ev) throw erreur(404, 'Événement introuvable.');
  return ev;
}

/** Délai de notification (jours entre le début et la transmission) ; null si le début est inconnu. */
const delaiNotification = (ev) => (ev.dateDebut ? Math.max(0, Math.round((new Date(ev.dateNotification).getTime() - Date.parse(`${ev.dateDebut}T00:00:00+01:00`)) / JOUR)) : null);

async function vueEvenement(ev, entites) {
  entites ??= new Map((await EntiteGeographique.find({ code: ev.entiteCode }).lean()).map((e) => [e.code, e]));
  return { ...ev.toJSON(), libelleMaladie: libelleMaladie(ev.maladie), territoire: entites.get(ev.entiteCode)?.nom ?? ev.entiteCode, delaiNotificationJours: delaiNotification(ev) };
}

exports.listerEvenements = async (req, res) => {
  const f = await filtreBase(req.query, 'dateDebut');
  if (req.query.etat) f.etat = texte(req.query.etat, 30);
  if (req.query.maladie) f.maladie = texte(req.query.maladie, 30);
  if (req.query.actifs === 'oui') f.etat = { $ne: 'Clôturé' };
  const liste = await EvenementSanitaire.find(f).sort({ dateNotification: -1 }).limit(500);
  const entites = new Map((await EntiteGeographique.find({ code: { $in: liste.map((x) => x.entiteCode) } }).lean()).map((e) => [e.code, e]));
  res.json(await Promise.all(liste.map((x) => vueEvenement(x, entites))));
};

exports.obtenirEvenement = async (req, res) => {
  const ev = await trouverEvenement(req.params.id);
  const cas = await CasSurveillance.find({ evenementNumero: ev.numero, statut: { $ne: 'Archivé' } });
  const parClassification = Object.fromEntries(epi.CLASSIFICATIONS_CAS.map((k) => [k, cas.filter((x) => x.classification === k).length]));
  const decesCas = cas.filter((x) => x.issue === 'Décédé' && x.classification !== 'Non-cas').length;
  const casValides = cas.filter((x) => x.classification !== 'Non-cas').length;
  const exposes = ev.investigation?.personnesExposees;
  res.json({
    ...(await vueEvenement(ev)),
    cas: { total: cas.length, parClassification, deces: decesCas },
    letalite: { ...ratio(decesCas, casValides), formule: 'Décès attribués ÷ cas (suspects, probables, confirmés) × 100' },
    tauxAttaque: { ...ratio(casValides, exposes ?? null), formule: 'Cas pendant la période ÷ population exposée × 100' },
  });
};

exports.modifierEvenement = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Action réservée au personnel habilité.');
  const ev = await trouverEvenement(req.params.id);
  const d = objet(req.body);
  const champs = lireEvenement(d, true);
  const r = await c.modifier(req, 'evenement', ev, (doc) => Object.assign(doc, champs), d.motif);
  await c.tracer(req, 'epi.evenement', { type: 'evenement', id: r.numero }, { operation: 'modification' });
  res.json(await vueEvenement(r));
};

/** Changement d'état de l'événement, historisé (vérifié, en suivi…). */
async function changerEtat(req, ev, etat, motif) {
  if (ev.etat === etat) return;
  const ancien = ev.etat;
  ev.etat = etat;
  if (etat === 'Clôturé') ev.clotureLe = new Date();
  ev.historique.push({ operation: `État : ${ancien} → ${etat}`, version: ev.version, ancienStatut: ev.statut, nouveauStatut: ev.statut, motif: motif ?? '', par: c.auteur(req), le: new Date() });
}

/** Formulaire C — investigation (l'événement passe « En investigation »). */
exports.investigation = async (req, res) => {
  await c.exigerPlanification(req);
  const ev = await trouverEvenement(req.params.id);
  if (ev.etat === 'Clôturé') throw erreur(409, 'Événement clôturé.');
  const d = objet(req.body);
  const i = { ...(ev.investigation?.toObject?.() ?? {}) };
  for (const k of ['equipe', 'responsable', 'hypothese', 'resultatsPrelevements', 'mesuresImmediates', 'besoinsMedicaments', 'besoinsPersonnel', 'recommandations', 'rapport', 'conclusion']) {
    if (d[k] !== undefined) i[k] = texte(d[k], 4000);
  }
  if (d.debut !== undefined) i.debut = jour(d.debut, 'Début de l’investigation');
  if (d.transmissionRapport !== undefined) i.transmissionRapport = jour(d.transmissionRapport, 'Date de transmission du rapport');
  if (d.personnesInterrogees !== undefined) i.personnesInterrogees = entierOuNull(d.personnesInterrogees, 'Personnes interrogées');
  if (d.personnesExposees !== undefined) i.personnesExposees = entierOuNull(d.personnesExposees, 'Personnes exposées');
  if (!i.debut || !i.responsable) throw erreur(400, 'Indiquez la date de début et le responsable de l’investigation.');
  i.par = c.auteur(req);
  i.le = new Date();
  ev.investigation = i;
  if (['Nouveau', 'Vérifié'].includes(ev.etat)) await changerEtat(req, ev, 'En investigation', 'Investigation enregistrée');
  else ev.historique.push({ operation: 'Investigation mise à jour', version: ev.version, nouveauStatut: ev.statut, par: c.auteur(req), le: new Date() });
  await ev.save();
  await c.tracer(req, 'epi.evenement', { type: 'evenement', id: ev.numero }, { operation: 'investigation' });
  res.json(await vueEvenement(ev));
};

/** Point de suivi : évolution des cas et décès, observation. */
exports.suivi = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Action réservée au personnel habilité.');
  const ev = await trouverEvenement(req.params.id);
  if (ev.etat === 'Clôturé') throw erreur(409, 'Événement clôturé.');
  const d = objet(req.body);
  const date = pasFutur(jour(d.date, 'Date') ?? new Date().toISOString().slice(0, 10), 'La date');
  ev.suivis.push({ date, cas: entierOuNull(d.cas, 'Cas'), deces: entierOuNull(d.deces, 'Décès'), observation: texte(d.observation, 2000), par: c.auteur(req) });
  if (ev.etat === 'En investigation' || ev.etat === 'Vérifié') await changerEtat(req, ev, 'En suivi', 'Suivi de l’événement');
  await ev.save();
  await c.tracer(req, 'epi.evenement', { type: 'evenement', id: ev.numero }, { operation: 'suivi' });
  res.json(await vueEvenement(ev));
};

exports.changerEtat = async (req, res) => {
  await c.exigerPlanification(req);
  const ev = await trouverEvenement(req.params.id);
  const d = objet(req.body);
  const etat = choix(d.etat, epi.STATUTS_EVENEMENT, 'État');
  if (etat === 'Clôturé' && !texte(d.motif, 2000) && !ev.investigation?.conclusion) throw erreur(400, 'Indiquez la conclusion de l’événement avant de le clôturer.');
  if (ev.etat === 'Clôturé' && etat !== 'Clôturé' && !texte(d.motif, 2000)) throw erreur(400, 'Indiquez le motif de la réouverture.');
  await changerEtat(req, ev, etat, texte(d.motif, 2000));
  await ev.save();
  await c.tracer(req, 'epi.evenement', { type: 'evenement', id: ev.numero }, { operation: 'etat', etat });
  res.json(await vueEvenement(ev));
};

// --- Formulaire B : cas ------------------------------------------------------------------------

/** Dossier AMI lié au cas, accessible au soignant (établissement de connexion). */
async function personneLiee(req, numero) {
  numero = texte(numero, 30).toUpperCase();
  if (!numero) return undefined;
  if (/^AC-PAT-\d+$/.test(numero)) {
    const p = await Patiente.findOne({ numero, etablissementId: req.etablissementId ?? '__aucun__' }).select('numero').lean();
    if (!p) throw erreur(404, 'Dossier patiente introuvable dans votre établissement.');
    return { type: 'Patiente', id: String(p._id), numero };
  }
  if (/^AC-ENF-\d+$/.test(numero)) {
    const e = await Enfant.findOne({ numero }).select('numero etablissementId mereId').lean();
    const mere = e && await Patiente.findById(e.mereId).select('etablissementId').lean();
    if (!e || ![e.etablissementId, mere?.etablissementId].includes(req.etablissementId)) throw erreur(404, 'Dossier enfant introuvable dans votre établissement.');
    return { type: 'Enfant', id: String(e._id), numero };
  }
  throw erreur(400, 'Identifiant AMI invalide (AC-PAT-… ou AC-ENF-…).');
}
exports.personneLiee = personneLiee;

function lireCas(d, partiel = false) {
  const o = {};
  const p = (k) => !partiel || d[k] !== undefined;
  if (p('sexe')) o.sexe = choix(d.sexe, epi.SEXES, 'Sexe');
  if (p('maladie')) { if (!epi.PAR_MALADIE.has(d.maladie)) throw erreur(400, 'Maladie invalide.'); o.maladie = d.maladie; }
  if (p('classification')) o.classification = choix(d.classification, epi.CLASSIFICATIONS_CAS, 'Classification du cas');
  if (d.resultatLabo !== undefined) o.resultatLabo = choix(d.resultatLabo, epi.RESULTATS_LABO, 'Résultat laboratoire');
  if (d.issue !== undefined) o.issue = choix(d.issue, epi.ISSUES_CAS, 'Issue');
  if (d.ageAnnees !== undefined) o.ageAnnees = entierOuNull(d.ageAnnees, 'Âge (années)');
  if (d.ageMois !== undefined) o.ageMois = entierOuNull(d.ageMois, 'Âge (mois)');
  for (const [k, l] of [['dateNaissance', 'Date de naissance'], ['dateDebutSymptomes', 'Date de début des symptômes'], ['dateConsultation', 'Date de consultation'], ['datePrelevement', 'Date de prélèvement'], ['dateCloture', 'Date de clôture']]) {
    if (d[k] !== undefined) o[k] = pasFutur(jour(d[k], l), l);
  }
  if (o.dateDebutSymptomes && o.dateConsultation && o.dateConsultation < o.dateDebutSymptomes) throw erreur(400, 'La consultation précède le début des symptômes.');
  return o;
}

exports.enregistrerCas = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Enregistrement réservé au personnel habilité.');
  const d = objet(req.body);
  const e = await c.entite(d.entiteCode);
  const champs = lireCas(d);
  if (champs.ageAnnees == null && !champs.dateNaissance) throw erreur(400, 'Indiquez l’âge ou la date de naissance du cas.');
  let evenementNumero = null;
  if (d.evenementNumero) evenementNumero = (await trouverEvenement(d.evenementNumero)).numero;
  const personne = await personneLiee(req, d.personneNumero);
  // Recherche des doublons avant consolidation : même dossier et même maladie sur 30 jours, ou
  // même profil (sexe, âge, lieu, maladie, début des symptômes).
  if (!d.forcer) {
    const ref = champs.dateDebutSymptomes ?? champs.dateConsultation;
    const fenetre = ref ? { $gte: new Date(Date.parse(ref) - 30 * JOUR).toISOString().slice(0, 10), $lte: new Date(Date.parse(ref) + 30 * JOUR).toISOString().slice(0, 10) } : null;
    const conditions = [];
    if (personne) conditions.push({ 'personne.numero': personne.numero, maladie: champs.maladie, ...(fenetre ? { $or: [{ dateDebutSymptomes: fenetre }, { dateConsultation: fenetre }] } : {}) });
    if (champs.dateDebutSymptomes) conditions.push({ maladie: champs.maladie, sexe: champs.sexe, ageAnnees: champs.ageAnnees ?? null, entiteCode: e.code, dateDebutSymptomes: champs.dateDebutSymptomes });
    const doublon = conditions.length && await CasSurveillance.findOne({ $or: conditions, statut: { $nin: ['Archivé', 'Rejeté'] } }).select('numero').lean();
    if (doublon) throw erreur(409, `Doublon possible avec le cas ${doublon.numero}. Vérifiez, puis confirmez l’enregistrement si ce n’est pas le même cas.`, { doublon: doublon.numero });
  }
  const cas = new CasSurveillance({
    ...champs, entiteCode: e.code, etablissementId: req.etablissementId ?? null, evenementNumero, personne, creePar: c.auteur(req),
    statut: d.brouillon ? 'Brouillon' : 'Soumis', soumission: d.brouillon ? undefined : { par: c.auteur(req), le: new Date() },
  });
  cas.tracer('Enregistrement', c.auteur(req));
  await cas.validate({ pathsToSkip: ['numero'] }).catch((err) => { throw erreur(400, require('../../config/erreursFr').messageValidation(err)); });
  await enregistrerNumerote(cas, `CAS-${new Date().getFullYear()}`);
  await c.tracer(req, 'epi.cas', { type: 'cas', id: cas.numero }, { operation: 'enregistrement', maladie: cas.maladie, classification: cas.classification });
  res.status(201).json(vueCas(req, cas));
};

/** Vue d'un cas : la référence au dossier AMI n'est visible que dans l'établissement du cas. */
function vueCas(req, x, entites = new Map()) {
  const j = x.toJSON();
  if (x.etablissementId !== req.etablissementId) j.personne = x.personne ? { type: x.personne.type, masque: true } : undefined;
  return { ...j, libelleMaladie: libelleMaladie(x.maladie), territoire: entites.get(x.entiteCode)?.nom ?? x.entiteCode, semaine: x.dateReference() ? semaineEpi(x.dateReference()) : null };
}

async function trouverCas(id) {
  const x = mongoose.isValidObjectId(id) ? await CasSurveillance.findById(id) : await CasSurveillance.findOne({ numero: texte(id, 30) });
  if (!x) throw erreur(404, 'Cas introuvable.');
  return x;
}

exports.listerCas = async (req, res) => {
  const f = await filtreBase(req.query, 'dateDebutSymptomes');
  for (const k of ['maladie', 'classification', 'issue', 'statut']) if (req.query[k]) f[k] = texte(req.query[k], 40);
  if (req.query.evenement) f.evenementNumero = texte(req.query.evenement, 30);
  if (!f.statut && req.query.archives !== 'oui') f.statut = { $ne: 'Archivé' };
  const liste = await CasSurveillance.find(f).sort({ createdAt: -1 }).limit(1000);
  const entites = new Map((await EntiteGeographique.find({ code: { $in: liste.map((x) => x.entiteCode) } }).lean()).map((e) => [e.code, e]));
  if (liste.some((x) => x.personne && x.etablissementId === req.etablissementId)) await c.tracer(req, 'epi.lecture.nominative', { type: 'cas', id: null }, { nombre: liste.length });
  res.json(liste.map((x) => vueCas(req, x, entites)));
};

exports.modifierCas = async (req, res) => {
  await c.exiger(req, epi.ROLES_SAISIE, 'Action réservée au personnel habilité.');
  const x = await trouverCas(req.params.id);
  const d = objet(req.body);
  const champs = lireCas(d, true);
  const r = await c.modifier(req, 'cas', x, (doc) => Object.assign(doc, champs), d.motif);
  await c.tracer(req, 'epi.cas', { type: 'cas', id: r.numero }, { operation: 'modification' });
  res.json(vueCas(req, r));
};

// --- Tableau de surveillance (§5.6–5.8) ----------------------------------------------------------

/**
 * Indicateurs de surveillance d'un territoire et d'une période : cas validés par maladie et par
 * classification, décès, létalité, variation par rapport à la période précédente, courbe
 * épidémique par semaine, délais de notification, événements par état et par zone.
 * Les cas non validés sont comptés à part : ils ne sont jamais présentés comme consolidés.
 */
async function tableau(q) {
  const code = q.dans ? texte(q.dans, 80).toUpperCase() : 'CD';
  const p = c.periode(q);
  const prec = c.periodePrecedente(p);
  const entites = await c.descendants(code);
  const codes = entites.map((e) => e.code);
  const nomDe = new Map(entites.map((e) => [e.code, e]));
  const [cas, casPrec, evenements] = await Promise.all([
    CasSurveillance.find({ entiteCode: { $in: codes }, statut: { $nin: ['Archivé', 'Rejeté'] }, classification: { $ne: 'Non-cas' } }),
    CasSurveillance.find({ entiteCode: { $in: codes }, statut: 'Validé', classification: { $ne: 'Non-cas' } }).select('maladie dateDebutSymptomes dateConsultation createdAt'),
    EvenementSanitaire.find({ entiteCode: { $in: codes }, statut: { $ne: 'Archivé' }, $or: [{ dateDebut: { $gte: p.du, $lte: p.au } }, { dateDebut: null, dateNotification: { $gte: new Date(`${p.du}T00:00:00+01:00`), $lte: new Date(`${p.au}T23:59:59+01:00`) } }] }),
  ]);
  const dans = (x, per) => { const r = x.dateReference(); return r >= per.du && r <= per.au; };
  const periodeCas = cas.filter((x) => dans(x, p));
  const valides = periodeCas.filter((x) => x.statut === 'Validé');
  const precedents = casPrec.filter((x) => dans(x, prec));
  const parMaladie = new Map();
  for (const x of periodeCas) {
    if (!parMaladie.has(x.maladie)) parMaladie.set(x.maladie, { maladie: x.maladie, libelle: libelleMaladie(x.maladie), suspects: 0, probables: 0, confirmes: 0, deces: 0, casValides: 0, nonValides: 0 });
    const m = parMaladie.get(x.maladie);
    if (x.statut !== 'Validé') { m.nonValides += 1; continue; }
    m.casValides += 1;
    if (x.classification === 'Suspect') m.suspects += 1;
    if (x.classification === 'Probable') m.probables += 1;
    if (x.classification === 'Confirmé') m.confirmes += 1;
    if (x.issue === 'Décédé') m.deces += 1;
  }
  const maladies = [...parMaladie.values()].map((m) => {
    const precedent = precedents.filter((x) => x.maladie === m.maladie).length;
    const v = variation(m.casValides, precedent);
    return { ...m, letalite: ratio(m.deces, m.casValides).valeur, precedent, variation: v.valeur, variationRaison: v.raison };
  }).sort((a, b) => b.casValides - a.casValides);
  // Courbe épidémique : nouveaux cas validés par semaine (début des symptômes), par maladie.
  const semaines = new Map();
  for (const x of valides) {
    const s = semaineEpi(x.dateReference());
    if (!semaines.has(s)) semaines.set(s, {});
    semaines.get(s)[x.maladie] = (semaines.get(s)[x.maladie] ?? 0) + 1;
  }
  const delais = evenements.map(delaiNotification).filter((x) => x != null);
  const parZone = new Map();
  for (const ev of evenements) {
    const e = nomDe.get(ev.entiteCode);
    const k = e?.nom ?? ev.entiteCode;
    if (!parZone.has(k)) parZone.set(k, { territoire: k, niveau: e?.niveau, evenements: 0, cas: 0, deces: 0, actifs: 0 });
    const z = parZone.get(k);
    z.evenements += 1; z.cas += ev.casSignales; z.deces += ev.decesSignales; if (ev.etat !== 'Clôturé') z.actifs += 1;
  }
  return {
    periode: p, precedente: prec, territoire: code,
    resume: {
      evenements: evenements.length, evenementsActifs: evenements.filter((x) => x.etat !== 'Clôturé').length,
      casValides: valides.length, casNonValides: periodeCas.length - valides.length,
      confirmes: valides.filter((x) => x.classification === 'Confirmé').length,
      deces: valides.filter((x) => x.issue === 'Décédé').length,
      sansInvestigation: evenements.filter((x) => x.etat !== 'Clôturé' && !x.investigation && ['Critique', 'Élevée'].includes(x.priorite)).length,
      delaiMoyenNotificationJours: delais.length ? Math.round((delais.reduce((s, x) => s + x, 0) / delais.length) * 10) / 10 : null,
    },
    maladies,
    courbe: [...semaines.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([semaine, n]) => ({ semaine, total: Object.values(n).reduce((s, x) => s + x, 0), parMaladie: n })),
    parEtat: epi.STATUTS_EVENEMENT.map((etat) => ({ etat, n: evenements.filter((x) => x.etat === etat).length })),
    parZone: [...parZone.values()].sort((a, b) => b.cas - a.cas),
    delais: evenements.filter((x) => delaiNotification(x) != null).map((x) => ({ numero: x.numero, maladie: libelleMaladie(x.maladie), jours: delaiNotification(x) })),
    formules: {
      letalite: 'Létalité = décès attribués à la maladie ÷ cas de la maladie × 100 (cas validés, hors non-cas)',
      variation: 'Variation = (cas période − cas période précédente) ÷ cas période précédente × 100 ; « non calculable » si la période précédente n’a aucun cas',
      delai: 'Délai de notification = date de notification − date de début (jours)',
    },
  };
}
exports.calculTableau = tableau;

exports.tableau = async (req, res) => {
  res.json(await tableau({ ...req.query, dans: req.query.dans || await c.entiteParDefaut(req) }));
};
