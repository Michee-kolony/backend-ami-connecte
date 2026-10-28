// Application RECO (espace /reco d'ami-sante) : connexion par matricule, tâches attribuées,
// actions de relance (en ligne ou hors connexion), signalements.
// Le RECO ne voit que le strict nécessaire : nom, quartier et repère, téléphone seulement pour
// les canaux consentis, motif sans détail clinique (sections 11 et 14).
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const mongoose = require('mongoose');
const Reco = require('../models/Reco');
const TacheRelance = require('../models/TacheRelance');
const AlerteRelance = require('../models/AlerteRelance');
const Patiente = require('../models/Patiente');
const Enfant = require('../models/Enfant');
const Etablissement = require('../models/Etablissement');
const { journaliser } = require('../config/audit');
const moteur = require('../config/moteurRelance');
const r = require('../config/relance');
const { motDePasseValide } = require('./flotte');
const { erreur, texte, objet } = require('./saisie');

const OPERATION = /^[A-Za-z0-9_-]{8,80}$/;
/** Tâches clôturées encore affichées au RECO (résultat de son travail). */
const CLOTUREES_JOURS = 30;
const MAX_OPERATIONS = 200;

function profil(reco, etablissement) {
  return {
    id: reco.id, matricule: reco.matricule, prenom: reco.prenom, nom: reco.nom, postnom: reco.postnom, telephone: reco.telephone, photo: reco.photo,
    aireSante: reco.aireSante, zones: reco.zones, doitChangerMotDePasse: reco.doitChangerMotDePasse,
    structure: etablissement ? { id: etablissement.id, nom: etablissement.nom, telephone: etablissement.telephone } : null,
    derniereSynchronisation: reco.derniereSynchronisation,
  };
}

exports.connexion = async (req, res) => {
  const matricule = texte(req.body?.matricule, 20).toUpperCase();
  const motDePasse = String(req.body?.motDePasse || '');
  if (!matricule || !motDePasse) throw erreur(400, 'Matricule et mot de passe requis.');
  const reco = await Reco.findOne({ matricule }).select('+motDePasse');
  // Même message dans tous les cas pour ne pas révéler quels matricules existent.
  if (!reco || !(await bcrypt.compare(motDePasse, reco.motDePasse))) throw erreur(401, 'Matricule ou mot de passe incorrect.');
  if (reco.statut !== 'Actif') throw erreur(403, 'Votre compte est suspendu. Contactez votre superviseur.');
  reco.derniereConnexion = new Date();
  await reco.save();
  const jeton = jwt.sign({ sub: reco.id, typ: 'reco' }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_RECO_EXPIRES_IN || '12h' });
  req.reco = reco;
  await journaliser(req, { action: 'reco.connexion', ressource: { type: 'reco', id: reco.matricule } });
  const [etablissement] = await Etablissement.actifsParIds([reco.etablissementId]);
  res.json({ jeton, reco: profil(reco, etablissement) });
};

exports.moi = async (req, res) => {
  const [etablissement] = await Etablissement.actifsParIds([req.reco.etablissementId]);
  res.json(profil(req.reco, etablissement));
};

exports.changerMotDePasse = async (req, res) => {
  const reco = await Reco.findById(req.reco._id).select('+motDePasse');
  if (!(await bcrypt.compare(String(req.body?.actuel || ''), reco.motDePasse))) throw erreur(400, 'Mot de passe actuel incorrect.');
  const nouveau = req.body?.nouveau;
  if (!motDePasseValide(nouveau)) throw erreur(400, 'Mot de passe trop faible (10 caractères, majuscules, minuscules, chiffre et caractère spécial).');
  reco.motDePasse = await bcrypt.hash(nouveau, 12);
  reco.doitChangerMotDePasse = false;
  await reco.save();
  const [etablissement] = await Etablissement.actifsParIds([reco.etablissementId]);
  res.json(profil(reco, etablissement));
};

// --- Vue d'une tâche pour le RECO -----------------------------------------------------------

/** Canaux autorisés : visite à domicile (mission du RECO) et canaux consentis dans le dossier. */
function canauxAutorises(patiente) {
  const c = patiente?.consentements ?? {};
  return [...Object.entries(r.CONSENTEMENT_CANAL).filter(([, cle]) => c[cle] === true).map(([canal]) => canal), 'Visite à domicile'];
}

async function vuesTaches(reco, taches) {
  const patientes = new Map((await Patiente.find({ _id: { $in: taches.map((t) => t.patienteId).filter(Boolean) } })
    .select('prenom nom postnom telephone telephonePartage consentements adresse')).map((p) => [p.id, p]));
  const enfants = new Map((await Enfant.find({ _id: { $in: taches.map((t) => t.enfantId).filter(Boolean) } })
    .select('prenom nom sexe')).map((e) => [e.id, e]));
  const structures = new Map((await Etablissement.find({ _id: { $in: [...new Set(taches.map((t) => t.etablissementId).filter((id) => mongoose.isValidObjectId(id)))] } })
    .select('nom telephone')).map((e) => [e.id, e]));
  const maintenant = new Date();
  return taches.map((t) => {
    const p = t.patienteId ? patientes.get(String(t.patienteId)) : null;
    const e = t.enfantId ? enfants.get(String(t.enfantId)) : null;
    const canaux = t.personneType === 'Déclarée' ? ['Visite à domicile'] : canauxAutorises(p);
    const avecTelephone = canaux.some((c) => c !== 'Visite à domicile');
    const structure = structures.get(t.etablissementId);
    const mienne = String(t.recoId) === reco.id;
    return {
      numero: t.numero, statut: t.statut, priorite: t.priorite, echeance: t.echeance, enRetard: t.enRetard(maintenant),
      // Pas de domaine (CPN, vaccination…) : seul le motif neutre est transmis au téléphone.
      parcoursCode: t.parcoursCode, motif: r.MOTIF_RECO[t.domaine],
      attribueeAMoi: mienne,
      personne: t.personneType === 'Déclarée'
        ? { nom: t.declaree?.nom ?? '', quartier: t.declaree?.quartier ?? '', repere: t.declaree?.repere ?? '', telephone: t.declaree?.telephone ?? '' }
        : {
          nom: [p?.prenom, p?.nom, p?.postnom].filter(Boolean).join(' '),
          enfant: e ? { prenom: e.prenom || 'Enfant', sexe: e.sexe } : null,
          commune: p?.adresse?.commune ?? '', quartier: p?.adresse?.quartier ?? '', avenue: p?.adresse?.avenue ?? '', repere: p?.adresse?.repere ?? '',
          // Numéro seulement si un canal téléphonique est consenti ; téléphone partagé signalé.
          telephone: avecTelephone ? p?.telephone ?? '' : '',
          telephonePartage: !!p?.telephonePartage,
        },
      canauxAutorises: canaux,
      structure: structure ? { id: structure.id, nom: structure.nom, telephone: structure.telephone } : null,
      messageNeutre: r.messageNeutre({ reco, structure: structure?.nom }),
      tentativesEchouees: t.tentativesEchouees, tentativesMax: t.parametres?.tentativesMax ?? 3,
      contactEtabli: !!t.contactEtabliLe,
      visites: t.visites.map((v) => ({ prevueLe: v.prevueLe, realiseeLe: v.realiseeLe, resultat: v.resultat })),
      orientation: t.orientation ? { le: t.orientation.le, structure: t.orientation.structure, priorite: t.orientation.priorite, dateConseillee: t.orientation.dateConseillee } : null,
      // Le RECO voit ses propres actions (pas les commentaires des autres intervenants).
      actions: t.actions.filter((a) => a.par.id === reco.id).map((a) => ({
        operationId: a.operationId, type: a.type, canal: a.canal, resultat: a.resultat, motif: a.motif, commentaire: a.commentaire,
        date: a.date, le: a.le, conflit: a.conflit,
      })),
      misAJourLe: t.updatedAt,
    };
  });
}

/** Tâches ouvertes du RECO et tâches clôturées depuis 30 jours. */
exports.taches = async (req, res) => {
  const depuis = new Date(Date.now() - CLOTUREES_JOURS * r.JOUR);
  const taches = await TacheRelance.find({
    recoId: req.reco._id,
    $or: [{ ouverte: true }, { statutLe: { $gte: depuis } }],
  }).sort({ priorite: -1, echeance: 1 });
  const ordre = { Urgente: 0, Prioritaire: 1, Normale: 2 };
  taches.sort((a, b) => Number(!a.ouverte) - Number(!b.ouverte) || ordre[a.priorite] - ordre[b.priorite] || a.echeance - b.echeance);
  res.json({ serveurLe: new Date(), taches: await vuesTaches(req.reco, taches) });
};

exports.alertes = async (req, res) => {
  const alertes = await AlerteRelance.find({ destinataire: 'reco', recoId: req.reco._id }).sort({ derniereLe: -1 }).limit(50);
  res.json(alertes.map((a) => ({ id: a.id, type: a.type, libelle: r.ALERTES[a.type].libelle, taches: a.taches, occurrences: a.occurrences, derniereLe: a.derniereLe, ouverte: a.ouverte })));
};

exports.accuserAlerte = async (req, res) => {
  const id = req.params.id;
  const alerte = mongoose.isValidObjectId(id) ? await AlerteRelance.findOne({ _id: id, destinataire: 'reco', recoId: req.reco._id }) : null;
  if (!alerte) throw erreur(404, 'Alerte introuvable.');
  if (alerte.ouverte) {
    Object.assign(alerte, { ouverte: false, accuseLe: new Date(), accusePar: req.reco.auteur() });
    await alerte.save();
  }
  res.json({ id: alerte.id, ouverte: false });
};

// --- Actions ------------------------------------------------------------------------------

/** Date d'une action ; l'heure de l'appareil ne peut pas être dans le futur (5 min de tolérance). */
function dateAction(v, libelle, { futurPermis = false } = {}) {
  if (v === '' || v == null) return null;
  const d = new Date(typeof v === 'object' ? NaN : v);
  if (Number.isNaN(d.getTime())) throw erreur(400, `${libelle} invalide.`);
  if (!futurPermis && d.getTime() > Date.now() + 5 * 60000) throw erreur(400, `${libelle} ne peut pas être dans le futur.`);
  return d;
}

/** Lecture et contrôle d'une opération envoyée par l'appareil. */
function lireOperation(o) {
  const op = objet(o);
  const operationId = texte(op.operationId, 80);
  if (!OPERATION.test(operationId)) throw erreur(400, 'Identifiant d’opération invalide.');
  if (!r.ACTIONS_RECO.includes(op.type)) throw erreur(400, 'Action inconnue.');
  return {
    operationId,
    numero: texte(op.numero, 20),
    type: op.type,
    canal: op.canal == null || op.canal === '' ? null : String(op.canal),
    resultat: op.resultat == null || op.resultat === '' ? null : String(op.resultat),
    motif: texte(op.motif, 120) || null,
    commentaire: texte(op.commentaire, r.COMMENTAIRE_MAX),
    date: dateAction(op.date, 'La date', { futurPermis: true }),
    structure: op.structure ? texte(op.structure, 40) : null,
    priorite: r.PRIORITES.includes(op.priorite) ? op.priorite : null,
    le: dateAction(op.le, 'L’heure de l’action') ?? new Date(),
    appareil: texte(op.appareil, 80) || null,
    horsLigne: op.horsLigne === true,
  };
}

/** Échec de contact : compté, et « Non retrouvée » une fois le maximum de tentatives atteint. */
async function echec(tache, par, le) {
  tache.tentativesEchouees += 1;
  if (tache.tentativesEchouees >= (tache.parametres?.tentativesMax ?? 3)) {
    tache.changerStatut('Non retrouvée', par, { action: 'Nombre maximal de tentatives atteint', le, motif: `${tache.tentativesEchouees} tentatives sans contact` });
    return 'echecs_multiples';
  }
  if (tache.statut === 'Attribuée') tache.changerStatut('En cours', par, { action: 'Prise en charge', le });
  return null;
}

/**
 * Applique une action du RECO à la tâche. Les règles de transition sont celles du cycle de vie
 * (section 5) ; l'action est toujours conservée dans l'historique des actions.
 * Renvoie la liste des alertes à émettre.
 */
async function appliquer(tache, reco, op) {
  const par = reco.auteur();
  const { le } = op;
  const alertes = [];
  const prendreEnCharge = () => {
    if (tache.statut === 'Attribuée') tache.changerStatut('En cours', par, { action: 'Prise en charge', le });
  };

  switch (op.type) {
    case 'accepter':
      if (tache.statut !== 'Attribuée') throw erreur(409, 'Cette tâche est déjà prise en charge.');
      prendreEnCharge();
      break;

    case 'tentative': {
      if (!r.CANAUX.includes(op.canal) || op.canal === 'Visite à domicile') throw erreur(400, 'Choisissez le canal : appel, SMS ou WhatsApp.');
      if (!r.RESULTATS_TENTATIVE.includes(op.resultat)) throw erreur(400, 'Indiquez le résultat de la tentative.');
      const patiente = tache.patienteId ? await Patiente.findById(tache.patienteId).select('consentements') : null;
      if (!canauxAutorises(patiente).includes(op.canal)) throw erreur(403, `Canal « ${op.canal} » non autorisé : la personne n’a pas donné son accord pour ce canal.`);
      if (r.RESULTATS_CONTACT.includes(op.resultat)) {
        prendreEnCharge();
        tache.contactEtabliLe ??= le;
        if (['En cours', 'Visite planifiée'].includes(tache.statut)) tache.changerStatut('Contact établi', par, { action: `Contact établi (${op.canal})`, le });
      } else if (r.RESULTATS_NEUTRES.includes(op.resultat)) {
        prendreEnCharge();
      } else {
        const a = await echec(tache, par, le);
        if (a) alertes.push(a);
      }
      break;
    }

    case 'visite_planifiee':
      if (!op.date) throw erreur(400, 'Indiquez la date de la visite convenue.');
      prendreEnCharge();
      tache.visites.push({ prevueLe: op.date, planifieeLe: le });
      tache.changerStatut('Visite planifiée', par, { action: 'Visite planifiée', le, details: { prevueLe: op.date } });
      break;

    case 'visite_realisee': {
      if (!r.RESULTATS_VISITE.includes(op.resultat)) throw erreur(400, 'Indiquez le résultat de la visite.');
      prendreEnCharge();
      const visite = [...tache.visites].reverse().find((v) => !v.realiseeLe);
      if (visite) Object.assign(visite, { realiseeLe: le, resultat: op.resultat });
      else tache.visites.push({ prevueLe: le, planifieeLe: le, realiseeLe: le, resultat: op.resultat });
      if (r.RESULTATS_CONTACT.includes(op.resultat)) {
        tache.contactEtabliLe ??= le;
        tache.changerStatut('Contact établi', par, { action: 'Visite à domicile : contact établi', le });
      } else {
        if (tache.statut === 'Visite planifiée') tache.changerStatut('En cours', par, { action: `Visite sans contact (${op.resultat})`, le });
        const a = await echec(tache, par, le);
        if (a) alertes.push(a);
      }
      break;
    }

    case 'orientation': {
      if (!tache.contactEtabliLe) throw erreur(409, 'L’orientation se fait après un contact établi avec la personne.');
      const etablissementId = op.structure || tache.etablissementId;
      const [structure] = etablissementId ? await Etablissement.actifsParIds([etablissementId]) : [];
      if (!structure) throw erreur(400, 'Structure d’orientation introuvable.');
      const priorite = op.priorite ?? 'Normale';
      tache.orientation = { le, etablissementId: structure.id, structure: structure.nom, priorite, dateConseillee: op.date, par };
      tache.alertes.orientationNonConfirmee = null;
      tache.changerStatut('Orientée', par, { action: 'Orientation vers la structure', le, details: { structure: structure.nom, priorite } });
      if (priorite === 'Urgente') alertes.push('urgence');
      break;
    }

    case 'refus_report':
      if (!r.MOTIFS_REFUS.includes(op.motif)) throw erreur(400, 'Choisissez le motif du refus ou du report.');
      prendreEnCharge();
      tache.changerStatut('Refus / report', par, { action: op.motif, le, motif: op.commentaire, details: op.date ? { reportAu: op.date } : undefined });
      break;

    case 'demande_appui':
      if (!op.commentaire) throw erreur(400, 'Décrivez brièvement l’appui demandé.');
      tache.escalade = { le, motif: op.commentaire, vers: 'Superviseur communautaire', par };
      tache.changerStatut('Escaladée', par, { action: 'Demande d’appui', le, motif: op.commentaire });
      alertes.push('appui');
      break;

    case 'urgence':
      // Le RECO ne gère jamais seul une urgence : escalade immédiate vers un professionnel habilité.
      tache.priorite = 'Urgente';
      tache.escalade = { le, motif: op.commentaire || 'Danger ou besoin clinique urgent signalé', vers: 'Professionnel habilité', par };
      tache.changerStatut('Escaladée', par, { action: 'Urgence signalée', le, motif: op.commentaire });
      alertes.push('urgence');
      break;

    default:
      throw erreur(400, 'Action inconnue.');
  }
  return alertes;
}

/**
 * Traite une opération : jamais deux fois (operationId), et jamais au détriment d'une décision
 * plus récente. Une action reçue sur une tâche clôturée, réattribuée ou en supervision est
 * conservée comme conflit à arbitrer, sans changer la tâche (section 12).
 */
async function traiterOperation(req, brute) {
  const op = lireOperation(brute);
  const reco = req.reco;
  const tache = op.numero ? await TacheRelance.findOne({ numero: op.numero }) : null;
  const aEteAttribuee = tache && (String(tache.recoId) === reco.id
    || tache.historique.some((h) => h.details?.reco === reco.matricule));
  if (!aEteAttribuee) throw erreur(404, 'Tâche introuvable.');

  const deja = tache.actions.find((a) => a.operationId === op.operationId);
  if (deja) return { operationId: op.operationId, ok: true, rejouee: true, conflit: deja.conflit, statut: tache.statut };

  const action = {
    operationId: op.operationId, type: op.type, canal: op.canal, resultat: op.resultat, motif: op.motif, commentaire: op.commentaire,
    date: op.date, structure: op.structure, priorite: op.priorite, le: op.le, recuLe: new Date(), par: reco.auteur(),
    appareil: op.appareil, horsLigne: op.horsLigne,
  };
  const motifConflit = String(tache.recoId) !== reco.id ? 'Tâche réattribuée à un autre RECO'
    : !tache.estOuverte() ? `Tâche déjà « ${tache.statut} »`
    : !r.STATUTS_RECO.includes(tache.statut) ? `Tâche en supervision (« ${tache.statut} »)`
    : null;

  let alertes = [];
  if (motifConflit) {
    tache.actions.push({ ...action, conflit: true });
    tache.conflits.push({ operationId: op.operationId, motif: motifConflit, le: new Date() });
    tache.noter('Action reçue en conflit', reco.auteur(), { motif: motifConflit, details: { type: op.type, operationId: op.operationId } });
    alertes = ['conflit'];
  } else {
    alertes = await appliquer(tache, reco, op);
    tache.actions.push(action);
  }
  await tache.save();
  const destinataires = { etablissementId: tache.etablissementId, taches: [tache.numero] };
  for (const type of alertes) {
    await moteur.alerter(type, destinataires);
    // Urgence : la structure d'orientation est aussi prévenue.
    if (type === 'urgence' && tache.orientation?.etablissementId && tache.orientation.etablissementId !== tache.etablissementId) {
      await moteur.alerter(type, { etablissementId: tache.orientation.etablissementId, taches: [tache.numero] });
    }
  }
  await journaliser(req, {
    action: 'relance.tache.action', patienteId: tache.patienteId, ressource: { type: 'relance', id: tache.numero },
    details: { type: op.type, statut: tache.statut, horsLigne: op.horsLigne, conflit: !!motifConflit },
  });
  return { operationId: op.operationId, ok: true, conflit: !!motifConflit, motifConflit, statut: tache.statut, urgence: op.type === 'urgence' };
}

exports.agir = async (req, res) => {
  const resultat = await traiterOperation(req, { ...objet(req.body), numero: req.params.numero });
  const [tache] = await vuesTaches(req.reco, [await TacheRelance.findOne({ numero: req.params.numero })]);
  res.json({ ...resultat, tache });
};

/**
 * Synchronisation hors connexion : les opérations sont appliquées dans l'ordre où elles ont été
 * faites sur l'appareil. Chacune a son propre résultat ; une opération refusée n'empêche pas
 * les suivantes.
 */
exports.synchroniser = async (req, res) => {
  const operations = Array.isArray(req.body?.operations) ? req.body.operations : [];
  if (operations.length > MAX_OPERATIONS) throw erreur(413, `Au plus ${MAX_OPERATIONS} opérations par synchronisation.`);
  const tri = operations.map((o, i) => ({ o: objet(o), i }))
    .sort((a, b) => (Date.parse(a.o.le) || 0) - (Date.parse(b.o.le) || 0) || a.i - b.i);
  const resultats = [];
  for (const { o } of tri) {
    try {
      resultats.push(o.type === 'signalement' ? await signaler(req, o) : await traiterOperation(req, o));
    } catch (err) {
      if (!err.status || err.status >= 500) throw err;
      resultats.push({ operationId: o.operationId ?? null, ok: false, status: err.status, message: err.message });
    }
  }
  req.reco.derniereSynchronisation = new Date();
  await req.reco.save();
  await journaliser(req, {
    action: 'reco.synchronisation', ressource: { type: 'reco', id: req.reco.matricule },
    details: { operations: resultats.length, refusees: resultats.filter((x) => !x.ok).length, conflits: resultats.filter((x) => x.conflit).length },
  });
  res.json({ serveurLe: req.reco.derniereSynchronisation, resultats });
};

// --- Signalement --------------------------------------------------------------------------

/**
 * Situation déclarée par le RECO nécessitant vérification (section 4, « suivi communautaire ») :
 * la tâche part au superviseur, qui la rattache au bon dossier ou la clôture.
 */
async function signaler(req, brut) {
  const s = objet(brut);
  const operationId = texte(s.operationId, 80);
  if (!OPERATION.test(operationId)) throw erreur(400, 'Identifiant d’opération invalide.');
  const cleMotif = `SIGNALEMENT:${operationId}`;
  const existante = await TacheRelance.findOne({ clesMotifs: cleMotif });
  if (existante) return { operationId, ok: true, rejouee: true, numero: existante.numero, statut: existante.statut };

  const nom = texte(s.nom, 120);
  const quartier = texte(s.quartier, 120);
  if (!nom || !quartier) throw erreur(400, 'Nom de la personne et quartier requis.');
  const domaine = r.DOMAINES.includes(s.domaine) ? s.domaine : 'Suivi communautaire';
  const urgence = s.urgence === true;
  const commentaire = texte(s.commentaire, r.COMMENTAIRE_MAX);
  const le = dateAction(s.le, 'L’heure du signalement') ?? new Date();
  const reco = req.reco;
  const par = reco.auteur();
  const p = r.PARAMETRES_SIGNALEMENT;

  const tache = new TacheRelance({
    numero: await TacheRelance.prochainNumero(),
    domaine, source: 'RECO', personneType: 'Déclarée', cle: `${cleMotif}:Déclarée`,
    declaree: { nom, quartier, repere: texte(s.repere, 200), telephone: texte(s.telephone, 30) },
    motifs: [{ cle: cleMotif, libelle: `Situation signalée par le RECO : ${r.MOTIF_RECO[domaine].toLowerCase()}`, objet: { type: 'Signalement', id: operationId, libelle: commentaire }, dateEvenement: le, ajouteLe: new Date() }],
    clesMotifs: [cleMotif],
    etablissementId: reco.etablissementId, aireSante: reco.aireSante, zone: quartier,
    recoId: reco._id, superviseurId: reco.superviseurId, attribueeLe: le,
    priorite: urgence ? 'Urgente' : p.priorite, parametres: p, dateEvenement: le,
    echeance: new Date(Date.now() + p.delaiTraitementJours * r.JOUR),
    statut: 'Escaladée', escalade: { le, motif: commentaire || 'Vérification d’un signalement', vers: urgence ? 'Professionnel habilité' : 'Superviseur communautaire', par },
    creePar: par,
  });
  tache.historique.push({ action: 'Signalement du RECO', nouveauStatut: 'Escaladée', motif: commentaire, details: { urgence }, par, le });
  tache.actions.push({ operationId, type: urgence ? 'urgence' : 'demande_appui', commentaire, le, recuLe: new Date(), par, horsLigne: s.horsLigne === true, appareil: texte(s.appareil, 80) || null });
  await tache.save();
  await moteur.alerter(urgence ? 'urgence' : 'signalement', { etablissementId: tache.etablissementId, taches: [tache.numero] });
  await journaliser(req, { action: 'relance.signalement', ressource: { type: 'relance', id: tache.numero }, details: { domaine, urgence } });
  return { operationId, ok: true, numero: tache.numero, statut: tache.statut, urgence };
}

exports.signaler = async (req, res) => {
  res.status(201).json(await signaler(req, req.body));
};

/** Référentiel de l'application RECO (listes de choix, structures d'orientation). */
exports.referentiel = async (req, res) => {
  const structures = await Etablissement.find({ statut: 'Actif' }).select('nom zoneSante aireSante').sort({ nom: 1 });
  res.json({
    canaux: r.CANAUX, resultatsTentative: r.RESULTATS_TENTATIVE, resultatsVisite: r.RESULTATS_VISITE,
    motifsRefus: r.MOTIFS_REFUS, priorites: r.PRIORITES, domaines: r.DOMAINES, commentaireMax: r.COMMENTAIRE_MAX,
    structures: structures.map((e) => ({ id: e.id, nom: e.nom, zoneSante: e.zoneSante, aireSante: e.aireSante })),
  });
};

module.exports.vuesTaches = vuesTaches;
