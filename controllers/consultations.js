const mongoose = require('mongoose');
const Consultation = require('../models/Consultation');
const RendezVous = require('../models/RendezVous');
const { auteurDe } = require('../models/commun');
const { journaliser } = require('../config/audit');
const notifications = require('../config/notifications');
const { trouverGrossesse } = require('./patientes');
const cpn = require('../config/cpn');
const { messageValidation } = require('../config/erreursFr');

const { TYPES_CONSULTATION, CHAMPS_CLINIQUES } = Consultation;
const erreur = (status, message) => Object.assign(new Error(message), { status });
const texte = (v, max = 5000) => (v == null ? '' : String(v).trim().slice(0, max));
const nombre = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));
const listeTextes = (v) => (Array.isArray(v) ? v.map((x) => texte(x, 200)).filter(Boolean).slice(0, 30) : []);
const ouiNon = (v) => (v === true ? true : v === false ? false : null);
const objet = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});

/** Champs cliniques acceptés (liste blanche, valeurs converties : jamais d'objet brut). */
function champsCliniques(d = {}) {
  const c = {};
  for (const k of CHAMPS_CLINIQUES) {
    if (d[k] === undefined) continue;
    switch (k) {
      case 'type':
        if (!TYPES_CONSULTATION.includes(d.type)) throw erreur(400, 'Type de consultation inconnu.');
        c.type = d.type;
        break;
      case 'date': {
        const date = new Date(d.date);
        if (Number.isNaN(date.getTime())) throw erreur(400, 'Date de consultation invalide.');
        if (date.getTime() > Date.now() + 5 * 60000) throw erreur(400, 'La date de consultation ne peut pas être dans le futur.');
        c.date = date;
        break;
      }
      case 'constantes': {
        const s = d.constantes || {};
        c.constantes = {};
        for (const m of ['poidsKg', 'taSystolique', 'taDiastolique', 'temperature', 'pouls', 'hauteurUterineCm', 'bcf', 'saO2', 'frequenceRespiratoire']) c.constantes[m] = nombre(s[m]);
        break;
      }
      case 'facteursRisque':
      case 'examensDemandes':
        c[k] = listeTextes(d[k]);
        break;
      case 'traitements':
        c.traitements = (Array.isArray(d.traitements) ? d.traitements : [])
          .filter((t) => t && texte(t.produit))
          .slice(0, 30)
          .map((t) => ({
            produit: texte(t.produit, 200), dose: texte(t.dose, 100), voie: texte(t.voie, 60),
            frequence: texte(t.frequence, 100), duree: texte(t.duree, 100), indication: texte(t.indication, 300),
          }));
        break;
      case 'prochainRdv': {
        const r = d.prochainRdv || {};
        const date = r.date ? new Date(r.date) : null;
        if (date && Number.isNaN(date.getTime())) throw erreur(400, 'Date du prochain rendez-vous invalide.');
        c.prochainRdv = { date, motif: texte(r.motif, 200), consignes: texte(r.consignes, 500) };
        break;
      }
      case 'examenCpn': {
        const e = objet(d.examenCpn);
        const signes = objet(e.signes);
        c.examenCpn = {
          signes: Object.fromEntries(cpn.SIGNES_CPN.map(({ code }) => [code, ouiNon(signes[code])])),
          etatGeneral: cpn.ETATS_GENERAUX.includes(e.etatGeneral) ? e.etatGeneral : '',
          perimetreBrachialCm: nombre(e.perimetreBrachialCm),
          mouvementsFoetaux: texte(e.mouvementsFoetaux, 100),
          presentation: cpn.PRESENTATIONS.includes(e.presentation) ? e.presentation : '',
        };
        break;
      }
      case 'mesuresPreventives': {
        const m = objet(d.mesuresPreventives);
        c.mesuresPreventives = Object.fromEntries(cpn.MESURES_PREVENTIVES.map(({ code }) => {
          const v = objet(m[code]);
          return [code, { reponse: ouiNon(v.reponse), valeur: texte(v.valeur, 200) }];
        }));
        break;
      }
      case 'laboratoire': {
        const l = objet(d.laboratoire);
        c.laboratoire = Object.fromEntries(cpn.EXAMENS_LABO.map(({ code }) => [code, texte(l[code], 500)]));
        break;
      }
      case 'reference': {
        const r = objet(d.reference);
        const motifs = Array.isArray(r.motifs) ? [...new Set(r.motifs.filter((x) => cpn.MOTIFS_REFERENCE.includes(x)))] : [];
        c.reference = { motifs, precision: texte(r.precision, 1000) };
        break;
      }
      default:
        c[k] = texte(d[k]);
    }
  }
  return c;
}

async function trouver(id) {
  const c = mongoose.isValidObjectId(id) && await Consultation.findById(id);
  if (!c) throw erreur(404, 'Consultation introuvable.');
  return c;
}

/** Seul l'auteur d'un brouillon peut le compléter, le finaliser ou l'annuler. */
function verifierAuteur(c, req) {
  if (c.auteur.id !== req.soignant.id) throw erreur(403, 'Seul le médecin auteur de cette consultation peut la modifier.');
}

/** Référence horodatée par le serveur dès qu'un motif est coché ; effacée si plus aucun motif. */
function horodaterReference(c, dejaLe = null) {
  c.set('reference.le', c.reference?.motifs?.length ? dejaLe ?? c.reference.le ?? new Date() : null);
}

function valider(c) {
  return c.validate().catch((err) => {
    throw erreur(400, messageValidation(err));
  });
}

exports.lister = async (req, res) => {
  const g = await trouverGrossesse(req.params.id);
  res.json(await Consultation.find({ grossesseId: g._id }).sort({ date: -1 }));
};

/** Nouvelle consultation : l'auteur est le médecin authentifié (jamais un identifiant envoyé par le client). */
exports.creer = async (req, res) => {
  const g = await trouverGrossesse(req.params.id);
  const champs = champsCliniques(req.body);
  if (!champs.type) throw erreur(400, 'Type de consultation requis.');
  if (champs.type === 'Première consultation prénatale'
      && await Consultation.exists({ grossesseId: g._id, type: 'Première consultation prénatale', statut: 'Finalisée' })) {
    throw erreur(409, 'La première consultation prénatale de cette grossesse est déjà finalisée : choisissez « Suivi prénatal ».');
  }
  let rendezVousId = null;
  if (req.body?.rendezVousId && mongoose.isValidObjectId(req.body.rendezVousId)
      && await RendezVous.exists({ _id: req.body.rendezVousId, patienteId: g.patienteId })) {
    rendezVousId = req.body.rendezVousId;
  }
  const c = new Consultation({
    ...champs,
    date: champs.date ?? new Date(),
    patienteId: g.patienteId,
    grossesseId: g._id,
    etablissementId: req.etablissementId,
    auteur: auteurDe(req.soignant),
    rendezVousId,
  });
  horodaterReference(c);
  await valider(c);
  await c.save();
  await journaliser(req, { action: 'consultation.creation', patienteId: c.patienteId, ressource: { type: 'consultation', id: c.id }, details: { type: c.type } });
  if (req.body?.finaliser === true) return finaliser(c, req, res);
  res.status(201).json(c);
};

exports.obtenir = async (req, res) => {
  const c = await trouver(req.params.id);
  await journaliser(req, { action: 'consultation.lecture', patienteId: c.patienteId, ressource: { type: 'consultation', id: c.id } });
  res.json(c);
};

/** Brouillon uniquement : une consultation finalisée n'est jamais modifiée silencieusement. */
exports.modifier = async (req, res) => {
  const c = await trouver(req.params.id);
  if (c.statut !== 'Brouillon') throw erreur(409, 'Consultation finalisée ou annulée : ajoutez un addendum.');
  verifierAuteur(c, req);
  const dejaReferee = c.reference?.le ?? null;
  c.set(champsCliniques(req.body));
  horodaterReference(c, dejaReferee);
  await valider(c);
  await c.save();
  await journaliser(req, { action: 'consultation.modification', patienteId: c.patienteId, ressource: { type: 'consultation', id: c.id } });
  if (req.body?.finaliser === true) return finaliser(c, req, res);
  res.json(c);
};

/** Finalisation : verrouille la note, fige l'âge gestationnel, met à jour l'agenda. */
async function finaliser(c, req, res) {
  if (c.statut !== 'Brouillon') throw erreur(409, 'Cette consultation n’est plus un brouillon.');
  verifierAuteur(c, req);
  const g = await trouverGrossesse(String(c.grossesseId));
  const auteur = auteurDe(req.soignant);
  c.agJours = g.agJoursLe(c.date);
  c.statut = 'Finalisée';
  c.finaliseeLe = new Date();

  // Rendez-vous honoré par cette visite (indiqué, sinon celui du même jour).
  const jour = new Date(c.date);
  jour.setUTCHours(0, 0, 0, 0);
  const honore = c.rendezVousId
    ? await RendezVous.findById(c.rendezVousId)
    : await RendezVous.findOne({ patienteId: c.patienteId, statut: { $in: RendezVous.STATUTS_ACTIFS }, date: { $gte: jour, $lt: new Date(jour.getTime() + 86400000) } });
  if (honore && RendezVous.STATUTS_ACTIFS.includes(honore.statut)) {
    honore.historique.push({ action: 'Effectué', ancienStatut: honore.statut, nouveauStatut: 'Effectué', motif: `Consultation du ${jour.toISOString().slice(0, 10)}`, par: auteur, le: new Date() });
    honore.statut = 'Effectué';
    honore.modifiePar = auteur;
    await honore.save();
    c.rendezVousId = honore._id;
  }

  // Prochain rendez-vous recommandé → agenda.
  if (c.prochainRdv?.date && !c.prochainRdvId) {
    const rdv = await RendezVous.create({
      patienteId: c.patienteId, grossesseId: c.grossesseId, consultationId: c._id,
      date: c.prochainRdv.date, motif: c.prochainRdv.motif || 'Consultation prénatale de suivi',
      consignes: c.prochainRdv.consignes, etablissementId: c.etablissementId, creePar: auteur,
      historique: [{ action: 'Planifié', nouvelleDate: c.prochainRdv.date, nouveauStatut: 'Planifié', par: auteur, le: new Date() }],
    });
    c.prochainRdvId = rdv._id;
    await journaliser(req, { action: 'rdv.creation', patienteId: c.patienteId, ressource: { type: 'rendezvous', id: rdv.id } });
  }
  await c.save();
  await journaliser(req, { action: 'consultation.finalisation', patienteId: c.patienteId, ressource: { type: 'consultation', id: c.id }, details: { type: c.type } });
  // Conseils donnés à la patiente : visibles dans son application (rubrique Conseils).
  if (c.conseils) {
    notifications.notifierPatiente(c.patienteId, {
      titre: `Nouveau conseil de ${req.soignant.prenom} ${req.soignant.nom}`.trim(),
      corps: 'Votre médecin vous a laissé des conseils. Ouvrez l’application pour les lire.',
      donnees: { type: 'conseil', consultationId: c.id },
    });
  }
  res.json(c);
}

exports.finaliser = async (req, res) => finaliser(await trouver(req.params.id), req, res);

/** Correction d'une consultation finalisée : addendum signé, la note initiale reste intacte. */
exports.ajouterAddendum = async (req, res) => {
  const c = await trouver(req.params.id);
  if (c.statut !== 'Finalisée') throw erreur(409, 'Un addendum ne s’ajoute qu’à une consultation finalisée.');
  const t = texte(req.body?.texte);
  const motif = texte(req.body?.motif, 300);
  if (!t || !motif) throw erreur(400, 'Texte et motif de l’addendum obligatoires.');
  c.addenda.push({ texte: t, motif, auteur: auteurDe(req.soignant), le: new Date() });
  await c.save();
  await journaliser(req, { action: 'consultation.addendum', patienteId: c.patienteId, ressource: { type: 'consultation', id: c.id } });
  res.status(201).json(c);
};

/** Annulation avec motif (la consultation reste visible dans l'historique, jamais supprimée). */
exports.annuler = async (req, res) => {
  const c = await trouver(req.params.id);
  if (c.statut === 'Annulée') throw erreur(409, 'Cette consultation est déjà annulée.');
  verifierAuteur(c, req);
  const motif = texte(req.body?.motif, 300);
  if (!motif) throw erreur(400, 'Le motif d’annulation est obligatoire.');
  c.annulation = { motif, par: auteurDe(req.soignant), le: new Date() };
  c.statut = 'Annulée';
  await c.save();
  await journaliser(req, { action: 'consultation.annulation', patienteId: c.patienteId, ressource: { type: 'consultation', id: c.id } });
  res.json(c);
};
