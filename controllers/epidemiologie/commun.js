// Socle commun aux dix sous-fenêtres du module Épidémiologie (Partie I) : droits, périmètre
// territorial, période, cycle de validation (Brouillon → Soumis → Validé / Rejeté / À corriger →
// Archivé), versions et journal d'audit. Toutes les sous-fenêtres passent par ici : un référentiel
// géographique commun, un mécanisme commun de validation et de traçabilité.
const mongoose = require('mongoose');
const EntiteGeographique = require('../../models/EntiteGeographique');
const PopulationReference = require('../../models/PopulationReference');
const CoefficientDemographique = require('../../models/CoefficientDemographique');
const CalculCible = require('../../models/CalculCible');
const PlanCible = require('../../models/PlanCible');
const EvenementSanitaire = require('../../models/EvenementSanitaire');
const CasSurveillance = require('../../models/CasSurveillance');
const CasMorbidite = require('../../models/CasMorbidite');
const Deces = require('../../models/Deces');
const IndicateurEpi = require('../../models/IndicateurEpi');
const { auteurDe } = require('../../models/commun');
const { journaliser } = require('../../config/audit');
const epi = require('../../config/epidemiologie');
const { erreur, texte, objet } = require('../saisie');

const auteur = (req) => auteurDe(req.soignant);
const aRole = (req, roles) => roles.includes(req.soignant.role);

/** Refus serveur journalisé (le front masque aussi, mais le serveur décide). */
async function exiger(req, roles, message) {
  if (aRole(req, roles)) return;
  await journaliser(req, { action: 'acces.refuse', resultat: 'refusé', ressource: { type: 'epidemiologie', id: req.path }, details: { role: req.soignant.role } });
  throw erreur(403, message);
}
const exigerValidation = (req) => exiger(req, epi.ROLES_VALIDATION, 'Validation réservée aux validateurs désignés (médecin chef de service, médecin directeur).');
const exigerParametrage = (req) => exiger(req, epi.ROLES_PARAMETRAGE, 'Paramétrage réservé aux administrateurs du module (médecin chef de service, médecin directeur).');
const exigerPlanification = (req) => exiger(req, epi.ROLES_PLANIFICATION, 'Action réservée aux médecins et aux responsables (titulaires, superviseurs).');

/** Entrée du journal d'audit du module (jamais de donnée nominative). */
const tracer = (req, action, ressource, details) => journaliser(req, { action, ressource, details });

// --- Référentiel géographique --------------------------------------------------------------

async function entite(code) {
  const e = await EntiteGeographique.findOne({ code: texte(code, 80).toUpperCase() });
  if (!e) throw erreur(404, 'Entité géographique introuvable.');
  return e;
}

/** Entité et ses descendants (filtre `chemin`). */
const descendants = (code) => EntiteGeographique.find({ chemin: code, actif: true });

/** Établissements AMI (formations sanitaires) contenus dans une entité. */
async function etablissementsDe(code) {
  return (await EntiteGeographique.find({ chemin: code, niveau: 'Formation sanitaire', etablissementId: { $ne: null } }).select('etablissementId').lean())
    .map((e) => e.etablissementId);
}

/**
 * Périmètre des données issues des modules AMI pour une entité : toutes ses formations sanitaires
 * pour les profils de consolidation, sinon le seul établissement de connexion (cloisonnement des
 * dossiers, Partie III §4 « accès limité au territoire autorisé »).
 */
async function perimetre(req, code) {
  const tous = await etablissementsDe(code);
  if (aRole(req, epi.ROLES_CONSOLIDATION)) return { etablissementIds: tous, restreint: false };
  const propre = tous.filter((x) => x === req.etablissementId);
  return { etablissementIds: propre, restreint: propre.length !== tous.length };
}

/** Entité de la structure de connexion (filtre par défaut). */
async function entiteParDefaut(req) {
  if (req.etablissementId) {
    const fosa = await EntiteGeographique.findOne({ etablissementId: req.etablissementId });
    if (fosa) return fosa.code;
  }
  return 'CD';
}

/** Ancêtres et entité (du pays à l'entité), pour l'affichage du territoire. */
async function libelleTerritoire(code) {
  const e = await EntiteGeographique.findOne({ code }).lean();
  return e ? `${e.nom} (${e.niveau})` : code;
}

// --- Période (filtres communs) --------------------------------------------------------------

const JOUR_ISO = /^\d{4}-\d{2}-\d{2}$/;
const MOIS_ISO = /^\d{4}-(0[1-9]|1[0-2])$/;

/** Année demandée (4 chiffres), par défaut l'année en cours. */
function annee(v) {
  if (v === undefined || v === '' || v === null) return new Date().getFullYear();
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1950 || n > 2100) throw erreur(400, 'Année invalide.');
  return n;
}

/**
 * Période : ?du&au (jours ou mois AAAA-MM), sinon ?mois=AAAA-MM, ?trimestre=AAAA-T1, ?annee=AAAA.
 * Bornes en jours civils inclus.
 */
function periode(q = {}) {
  const fin = (m) => { const [a, mm] = m.split('-').map(Number); return new Date(Date.UTC(a, mm, 0)).toISOString().slice(0, 10); };
  if (q.du || q.au) {
    let du = texte(q.du, 10);
    let au = texte(q.au, 10);
    if (MOIS_ISO.test(du)) du = `${du}-01`;
    if (MOIS_ISO.test(au)) au = fin(au);
    if (!JOUR_ISO.test(du) || !JOUR_ISO.test(au) || du > au) throw erreur(400, 'Période invalide (du et au : AAAA-MM-JJ ou AAAA-MM).');
    return { du, au, libelle: `du ${du} au ${au}` };
  }
  if (q.mois) {
    const m = texte(q.mois, 7);
    if (!MOIS_ISO.test(m)) throw erreur(400, 'Mois invalide (AAAA-MM).');
    return { du: `${m}-01`, au: fin(m), libelle: `mois ${m}` };
  }
  if (q.trimestre) {
    const t = /^(\d{4})-T([1-4])$/.exec(texte(q.trimestre, 7));
    if (!t) throw erreur(400, 'Trimestre invalide (AAAA-T1 à AAAA-T4).');
    const m1 = (Number(t[2]) - 1) * 3 + 1;
    return { du: `${t[1]}-${String(m1).padStart(2, '0')}-01`, au: fin(`${t[1]}-${String(m1 + 2).padStart(2, '0')}`), libelle: `${t[2]}e trimestre ${t[1]}` };
  }
  const a = annee(q.annee);
  return { du: `${a}-01-01`, au: `${a}-12-31`, libelle: `année ${a}` };
}

/** Période précédente de même durée (comparaisons, variations). */
function periodePrecedente({ du, au }) {
  const JOUR = 86400000;
  const d = Date.parse(`${du}T00:00:00Z`);
  const duree = Date.parse(`${au}T00:00:00Z`) - d + JOUR;
  return { du: new Date(d - duree).toISOString().slice(0, 10), au: new Date(d - JOUR).toISOString().slice(0, 10) };
}

// --- Registre des données soumises à validation (sous-fenêtre 10) ---------------------------

/**
 * Types de données du module : modèle, libellé, résumé affiché dans la file de validation,
 * contrôles avant validation (anomalies bloquantes / avertissements) et effets après validation
 * (archivage de la version remplacée). `versionne` : une donnée validée modifiée devient une
 * nouvelle version (sinon : correction sur place, historisée, et nouvelle validation).
 */
const REGISTRE = {
  population: {
    Modele: PopulationReference, libelle: 'Population', versionne: true,
    resume: (d) => `${d.entiteCode} · ${d.annee} · ${d.totale?.toLocaleString('fr-FR')} hab. (v${d.version})`,
    periode: (d) => String(d.annee),
    controle: (d) => {
      const a = d.anomalies();
      return { bloquantes: a.filter((x) => x.startsWith('Hommes')), avertissements: a.filter((x) => !x.startsWith('Hommes')) };
    },
    // Une seule population active par entité et par année : la version validée précédente est archivée.
    apresValidation: (d) => PopulationReference.updateMany({ entiteCode: d.entiteCode, annee: d.annee, statut: 'Validé', _id: { $ne: d._id } }, { $set: { statut: 'Archivé' } }),
  },
  coefficient: {
    Modele: CoefficientDemographique, libelle: 'Coefficient', versionne: true,
    resume: (d) => `${d.code} ${d.nom} · ${String(d.valeurPct).replace('.', ',')} % · ${d.entiteCode} (v${d.version})`,
    periode: (d) => `${d.dateDebut} → ${d.dateFin ?? '…'}`,
    controle: (d) => ({ bloquantes: !d.source ? ['Aucun coefficient ne peut être activé sans source et justification.'] : [], avertissements: [] }),
    avantValidation: async (d) => {
      // Deux coefficients incompatibles ne doivent pas être actifs pour la même cible, territoire et période.
      const chevauche = { dateDebut: { $lte: d.dateFin ?? '9999-12-31' }, $or: [{ dateFin: null }, { dateFin: { $gte: d.dateDebut } }] };
      const conflit = await CoefficientDemographique.findOne({ cible: d.cible, entiteCode: d.entiteCode, statut: 'Validé', code: { $ne: d.code }, ...chevauche });
      if (conflit) throw erreur(409, `Coefficient incompatible déjà actif pour la même cible, le même territoire et la même période : ${conflit.code} (${conflit.nom}).`);
    },
    // Version précédente du même code : sa période s'arrête la veille, ou elle est archivée.
    apresValidation: async (d) => {
      const anciennes = await CoefficientDemographique.find({ code: d.code, statut: 'Validé', _id: { $ne: d._id } });
      for (const a of anciennes) {
        if (a.dateDebut < d.dateDebut) {
          const veille = new Date(Date.parse(`${d.dateDebut}T00:00:00Z`) - 86400000).toISOString().slice(0, 10);
          if (!a.dateFin || a.dateFin >= d.dateDebut) a.dateFin = veille;
        } else a.statut = 'Archivé';
        await a.save();
      }
    },
  },
  calcul: {
    Modele: CalculCible, libelle: 'Calcul des cibles', versionne: false,
    resume: (d) => `${d.numero} · ${d.entiteCode} · ${d.annee} · ${d.resultats.map((r) => `${r.cible} ${r.valeur}`).join(', ')}`,
    periode: (d) => String(d.annee),
    controle: async (d) => {
      const pop = await PopulationReference.findById(d.population.id).lean();
      const b = [];
      if (!pop || pop.statut !== 'Validé') b.push('La population de référence utilisée n’est plus validée : relancez le calcul.');
      if (d.simulation) b.push('Une simulation ne peut pas être validée.');
      if (!d.resultats.length) b.push('Aucune population cible calculée (coefficients validés manquants).');
      return { bloquantes: b, avertissements: d.manquantes.map((c) => `Cible non calculée : ${epi.CIBLES[c] ?? c} (coefficient validé absent).`) };
    },
    apresValidation: (d) => CalculCible.updateMany({ entiteCode: d.entiteCode, annee: d.annee, statut: 'Validé', _id: { $ne: d._id } }, { $set: { statut: 'Archivé' } }),
  },
  plan: {
    Modele: PlanCible, libelle: 'Plan', versionne: true,
    resume: (d) => `${d.numero} · ${d.intervention} · ${d.entiteCode} · ${d.annee} · cible ${d.cibleAnnuelle} (v${d.version})`,
    periode: (d) => String(d.annee),
    controle: (d) => {
      const b = [];
      const somme = d.mensuel.reduce((s, x) => s + x, 0);
      if (somme !== d.cibleAnnuelle) b.push(`La somme des objectifs mensuels (${somme}) doit correspondre à l’objectif annuel (${d.cibleAnnuelle}).`);
      if ((d.ajustee || d.repartition === 'Personnalisée') && !d.justification) b.push('Une cible ajustée ou une répartition non uniforme doit être justifiée.');
      const geo = d.geographique.reduce((s, x) => s + x.cible, 0);
      if (d.geographique.length && geo !== d.cibleAnnuelle && !d.justification) b.push(`La répartition géographique (${geo}) ne correspond pas à l’objectif (${d.cibleAnnuelle}) sans ajustement documenté.`);
      return { bloquantes: b, avertissements: [] };
    },
    apresValidation: (d) => PlanCible.updateMany({ numero: d.numero, statut: 'Validé', _id: { $ne: d._id } }, { $set: { statut: 'Archivé' } }),
  },
  indicateur: {
    Modele: IndicateurEpi, libelle: 'Indicateur', versionne: true,
    resume: (d) => `${d.code} ${d.nom} (v${d.version})`,
    periode: () => '',
    controle: (d) => ({ bloquantes: !d.referenceValidation ? ['Indiquez la référence de la fiche technique validée (PEV, santé maternelle…).'] : [], avertissements: [] }),
    apresValidation: (d) => IndicateurEpi.updateMany({ code: d.code, statut: 'Validé', _id: { $ne: d._id } }, { $set: { statut: 'Archivé' } }),
  },
  evenement: {
    Modele: EvenementSanitaire, libelle: 'Événement sanitaire', versionne: false,
    resume: (d) => `${d.numero} · ${epi.PAR_MALADIE.get(d.maladie)?.libelle ?? d.maladie} · ${d.casSignales} cas, ${d.decesSignales} décès`,
    periode: (d) => d.dateDebut ?? '',
    controle: () => ({ bloquantes: [], avertissements: [] }),
    // Notification vérifiée par le validateur : l'événement passe « Vérifié ».
    apresValidation: async (d) => {
      if (d.etat !== 'Nouveau') return;
      d.etat = 'Vérifié';
      await d.save();
    },
  },
  cas: {
    Modele: CasSurveillance, libelle: 'Cas de surveillance', versionne: false,
    resume: (d) => `${d.numero} · ${epi.PAR_MALADIE.get(d.maladie)?.libelle ?? d.maladie} · ${d.classification}`,
    periode: (d) => d.dateDebutSymptomes ?? d.dateConsultation ?? '',
    controle: (d) => ({
      bloquantes: [],
      avertissements: d.classification === 'Confirmé' && d.resultatLabo !== 'Positif' ? ['Cas confirmé sans résultat de laboratoire positif : vérifier la définition de cas.'] : [],
    }),
  },
  morbidite: {
    Modele: CasMorbidite, libelle: 'Cas de morbidité', versionne: false,
    resume: (d) => `${d.numero} · ${epi.PAR_MALADIE.get(d.diagnostic)?.libelle ?? d.diagnostic} · ${d.service}`,
    periode: (d) => d.dateConsultation,
    controle: () => ({ bloquantes: [], avertissements: [] }),
  },
  deces: {
    Modele: Deces, libelle: 'Décès', versionne: false,
    resume: (d) => `${d.numero} · ${d.causeInitiale}${d.maternel === 'Oui' ? ' · maternel' : ''}${d.neonatal === 'Oui' ? ' · néonatal' : ''}`,
    periode: (d) => d.dateDeces,
    controle: (d) => {
      const b = [];
      if (d.maternel === 'Oui' && d.sexe !== 'Féminin') b.push('Un décès maternel concerne une femme.');
      if (d.neonatal === 'Oui' && d.ageJours != null && d.ageJours >= 28) b.push('Décès néonatal : âge inférieur à 28 jours attendu.');
      return { bloquantes: b, avertissements: d.maternel === 'Oui' ? ['Décès maternel : vérifier la revue / l’audit (SDMPR) avant validation.'] : [] };
    },
  },
};

function typeDonnee(type) {
  const t = REGISTRE[type];
  if (!t) throw erreur(404, 'Type de donnée inconnu.');
  return t;
}

async function document(type, id) {
  const { Modele, libelle } = typeDonnee(type);
  if (!mongoose.isValidObjectId(id)) throw erreur(404, `${libelle} introuvable.`);
  const d = await Modele.findById(id);
  if (!d) throw erreur(404, `${libelle} introuvable.`);
  return d;
}

/** Contrôle automatique (conforme ou anomalie) avant décision. */
async function controler(type, d) {
  const c = await typeDonnee(type).controle(d);
  return { ...c, conforme: !c.bloquantes.length && !c.avertissements.length };
}

/**
 * Applique une modification. Brouillon, À corriger, Rejeté : sur place (historisée).
 * Soumis : refusé (en attente de décision). Archivé : refusé. Validé : nouvelle version pour les
 * référentiels (population, coefficient, plan, indicateur), sinon correction sur place avec motif
 * obligatoire et nouvelle soumission (« une donnée validée n'est jamais écrasée sans historique »).
 * Renvoie le document enregistré (éventuellement la nouvelle version).
 */
async function modifier(req, type, d, appliquer, motif = '') {
  const { Modele, versionne } = typeDonnee(type);
  motif = texte(motif, 500);
  if (d.statut === 'Soumis') throw erreur(409, 'Donnée en attente de validation : attendez la décision ou demandez une correction au validateur.');
  if (d.statut === 'Archivé') throw erreur(409, 'Donnée archivée : non modifiable (consultable dans l’historique).');
  if (d.statut === 'Validé' && !motif) throw erreur(400, 'Toute modification d’une donnée validée doit comporter un motif.');
  if (d.statut === 'Validé' && versionne) {
    const enCours = await Modele.findOne({ remplace: d._id, statut: { $in: ['Brouillon', 'Soumis', 'À corriger'] } }).select('version').lean();
    if (enCours) throw erreur(409, `Une nouvelle version (v${enCours.version}) est déjà en préparation : modifiez-la plutôt.`);
    const brut = d.toObject();
    for (const k of ['_id', 'id', 'createdAt', 'updatedAt', 'soumission', 'decision', 'historique', 'modifiePar']) delete brut[k];
    const nouveau = new Modele({ ...brut, version: d.version + 1, statut: 'Brouillon', remplace: d._id, creePar: auteur(req), historique: [] });
    const avant = nouveau.instantane();
    await appliquer(nouveau);
    nouveau.tracer('Nouvelle version', auteur(req), { avant, motif: motif || `Nouvelle version de v${d.version}` });
    await nouveau.validate().catch((e) => { throw erreur(400, require('../../config/erreursFr').messageValidation(e)); });
    try {
      await nouveau.save();
    } catch (e) {
      if (e.code === 11000) throw erreur(409, 'Cette version existe déjà : rechargez la page.');
      throw e;
    }
    return nouveau;
  }
  const avant = d.instantane();
  const ancienStatut = d.statut;
  await appliquer(d);
  if (ancienStatut === 'Validé' || ancienStatut === 'Rejeté') d.statut = ancienStatut === 'Validé' ? 'Soumis' : 'Brouillon';
  if (ancienStatut === 'Validé') d.soumission = { par: auteur(req), le: new Date() };
  d.modifiePar = auteur(req);
  d.tracer(ancienStatut === 'Validé' ? 'Correction' : 'Modification', auteur(req), { avant, motif, ancienStatut });
  await d.validate().catch((e) => { throw erreur(400, require('../../config/erreursFr').messageValidation(e)); });
  await d.save();
  return d;
}

/** Soumission pour validation (Brouillon / À corriger → Soumis). */
async function soumettre(req, type, d) {
  if (!['Brouillon', 'À corriger'].includes(d.statut)) throw erreur(409, `Seule une donnée en brouillon ou à corriger peut être soumise (statut : ${d.statut}).`);
  const ancienStatut = d.statut;
  d.statut = 'Soumis';
  d.soumission = { par: auteur(req), le: new Date() };
  d.tracer('Soumission', auteur(req), { ancienStatut });
  await d.save();
  await tracer(req, 'epi.soumission', { type, id: d.id }, { version: d.version });
  return d;
}

/**
 * Décision du validateur : valider, rejeter (motif) ou demander une correction (motif).
 * Séparation saisie / validation : l'auteur de la saisie ou de la soumission ne valide pas.
 */
async function decider(req, type, d, decision, motif) {
  await exigerValidation(req);
  const statut = epi.DECISIONS[decision];
  if (!statut) throw erreur(400, 'Décision invalide (valider, rejeter ou corriger).');
  if (d.statut !== 'Soumis') throw erreur(409, `Seule une donnée soumise peut faire l’objet d’une décision (statut : ${d.statut}).`);
  motif = texte(motif, 1000);
  if (decision !== 'valider' && !motif) throw erreur(400, 'Le motif est obligatoire pour un rejet ou une demande de correction.');
  if (epi.SEPARATION_SAISIE_VALIDATION && decision === 'valider'
      && [d.soumission?.par?.id, d.creePar?.id, d.modifiePar?.id].includes(req.soignant.id)) {
    throw erreur(403, 'Séparation des rôles : la personne qui a saisi ou soumis la donnée ne peut pas la valider.');
  }
  const c = await controler(type, d);
  if (decision === 'valider' && c.bloquantes.length) throw erreur(422, `Validation impossible : ${c.bloquantes.join(' ')}`, { anomalies: c.bloquantes });
  const t = typeDonnee(type);
  if (decision === 'valider' && t.avantValidation) await t.avantValidation(d);
  const ancienStatut = d.statut;
  d.statut = statut;
  d.decision = { decision: statut, motif, par: auteur(req), le: new Date(), controle: c.conforme ? 'Conforme' : [...c.bloquantes, ...c.avertissements].join(' ') };
  d.tracer(statut === 'Validé' ? 'Validation' : statut === 'Rejeté' ? 'Rejet' : 'Demande de correction', auteur(req), { motif, ancienStatut });
  await d.save();
  if (decision === 'valider' && t.apresValidation) await t.apresValidation(d);
  await tracer(req, 'epi.validation', { type, id: d.id }, { decision: statut, version: d.version });
  return d;
}

/** Archivage manuel (donnée conservée, mais non active). */
async function archiver(req, type, d, motif) {
  await exigerValidation(req);
  if (d.statut === 'Archivé') return d;
  if (!texte(motif, 500)) throw erreur(400, 'Indiquez le motif de l’archivage.');
  const ancienStatut = d.statut;
  d.statut = 'Archivé';
  d.tracer('Archivage', auteur(req), { motif: texte(motif, 500), ancienStatut });
  await d.save();
  await tracer(req, 'epi.archivage', { type, id: d.id }, { version: d.version });
  return d;
}

// --- Gestionnaires génériques (routes /:type/:id/…) -------------------------------------------

exports.soumettreRoute = async (req, res) => {
  const d = await document(req.params.type, req.params.id);
  res.json(await soumettre(req, req.params.type, d));
};
exports.deciderRoute = async (req, res) => {
  const d = await document(req.params.type, req.params.id);
  const b = objet(req.body);
  res.json(await decider(req, req.params.type, d, texte(b.decision, 20), b.motif));
};
exports.archiverRoute = async (req, res) => {
  const d = await document(req.params.type, req.params.id);
  res.json(await archiver(req, req.params.type, d, objet(req.body).motif));
};
exports.controleRoute = async (req, res) => {
  const d = await document(req.params.type, req.params.id);
  res.json(await controler(req.params.type, d));
};
exports.historiqueRoute = async (req, res) => {
  const { Modele } = typeDonnee(req.params.type);
  const d = await document(req.params.type, req.params.id);
  // Versions de la même donnée (chaîne « remplace ») pour retrouver les versions précédentes.
  const versions = [];
  let courant = d;
  while (courant?.remplace && versions.length < 50) {
    courant = await Modele.findById(courant.remplace);
    if (courant) versions.push({ id: courant.id, version: courant.version, statut: courant.statut, valeurs: courant.instantane(), le: courant.updatedAt });
  }
  res.json({ id: d.id, version: d.version, statut: d.statut, historique: d.historique, versionsPrecedentes: versions });
};

Object.assign(exports, {
  auteur, aRole, exiger, exigerValidation, exigerParametrage, exigerPlanification, tracer,
  entite, descendants, etablissementsDe, perimetre, entiteParDefaut, libelleTerritoire,
  annee, periode, periodePrecedente, REGISTRE, typeDonnee, document, controler, modifier, soumettre, decider, archiver,
});
