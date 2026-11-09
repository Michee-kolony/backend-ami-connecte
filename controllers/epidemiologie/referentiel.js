// Référentiel du module Épidémiologie : listes communes, droits de l'utilisateur et référentiel
// géographique (pays → province → ville/territoire → zone → aire → formation sanitaire → communauté).
const EntiteGeographique = require('../../models/EntiteGeographique');
const Etablissement = require('../../models/Etablissement');
const CoefficientDemographique = require('../../models/CoefficientDemographique');
const IndicateurEpi = require('../../models/IndicateurEpi');
const epi = require('../../config/epidemiologie');
const { ARRONDI } = epi;
const { erreur, texte, objet } = require('../saisie');
const c = require('./commun');

const SYSTEME = { id: 'systeme', nom: 'Paramétrage initial (cahier des charges)', role: 'Système', matricule: '' };
let initialise = null;

/**
 * Données de départ, une seule fois : racine « République démocratique du Congo », coefficients
 * proposés (§2.4) et fiches d'indicateurs, tous en BROUILLON (aucun effet avant validation).
 */
async function initialiser() {
  initialise ??= (async () => {
    if (!(await EntiteGeographique.exists({ code: 'CD' }))) {
      await EntiteGeographique.create({ code: 'CD', codeOfficiel: 'CD', niveau: 'Pays', nom: 'République démocratique du Congo', chemin: ['CD'], creePar: SYSTEME }).catch((e) => { if (e.code !== 11000) throw e; });
    }
    if (!(await CoefficientDemographique.exists({}))) {
      await CoefficientDemographique.insertMany(epi.COEFFICIENTS_INITIAUX.map((x) => ({
        ...x, entiteCode: 'CD', populationReference: 'Population totale', dateDebut: `${new Date().getFullYear()}-01-01`,
        commentaire: 'Hypothèse discutée pour AMI : à confirmer par les documents de référence nationaux avant activation.', creePar: SYSTEME,
        historique: [{ operation: 'Création', version: 1, nouveauStatut: 'Brouillon', motif: 'Paramètre initial du cahier des charges (§2.4)', par: SYSTEME, le: new Date() }],
      }))).catch((e) => { if (e.code !== 11000) throw e; });
    }
    if (!(await IndicateurEpi.exists({}))) {
      await IndicateurEpi.insertMany(epi.INDICATEURS_INITIAUX.map((x) => ({
        ...x, parametres: x.parametres ?? {}, seuilReference: x.seuil ?? null, creePar: SYSTEME,
        historique: [{ operation: 'Création', version: 1, nouveauStatut: 'Brouillon', motif: 'Fiche initiale du cahier des charges (§7.4)', par: SYSTEME, le: new Date() }],
      }))).catch((e) => { if (e.code !== 11000) throw e; });
    }
  })().catch((e) => { initialise = null; throw e; });
  return initialise;
}

exports.initialiser = initialiser;
/** Pour les tests : relancer l'initialisation sur une base vide. */
exports.reinitialiser = () => { initialise = null; };

exports.referentiel = async (req, res) => {
  await initialiser();
  res.json({
    niveaux: epi.NIVEAUX, statuts: epi.STATUTS, natures: epi.NATURES, tranchesAge: epi.TRANCHES_AGE,
    sourcesDemographiques: epi.SOURCES_DEMOGRAPHIQUES, methodes: epi.METHODES, cibles: epi.CIBLES, programmes: epi.PROGRAMMES, arrondi: ARRONDI,
    interventions: epi.INTERVENTIONS, typesEvenement: epi.TYPES_EVENEMENT, maladies: epi.MALADIES, categoriesMaladie: epi.CATEGORIES_MALADIE,
    priorites: epi.PRIORITES, statutsEvenement: epi.STATUTS_EVENEMENT, resultatsLabo: epi.RESULTATS_LABO, classificationsCas: epi.CLASSIFICATIONS_CAS,
    issuesCas: epi.ISSUES_CAS, sexes: epi.SEXES, services: epi.SERVICES, classificationsMorbidite: epi.CLASSIFICATIONS_MORBIDITE,
    issuesMorbidite: epi.ISSUES_MORBIDITE, lieuxDeces: epi.LIEUX_DECES, ouiNonNd: epi.OUI_NON_ND, sourcesDeces: epi.SOURCES_DECES,
    causesDeces: epi.CAUSES_DECES, unitesFrequence: epi.UNITES_FREQUENCE, unitesIndicateur: epi.UNITES_INDICATEUR, periodicites: epi.PERIODICITES,
    desagregations: epi.DESAGREGATIONS, domainesAlerte: epi.DOMAINES_ALERTE, statutsAlerte: epi.STATUTS_ALERTE, indicateursAlerte: epi.INDICATEURS_ALERTE,
    operateurs: epi.OPERATEURS, typesRapport: epi.TYPES_RAPPORT, formats: epi.FORMATS,
    entiteParDefaut: await c.entiteParDefaut(req),
    droits: {
      validation: c.aRole(req, epi.ROLES_VALIDATION),
      parametrage: c.aRole(req, epi.ROLES_PARAMETRAGE),
      consolidation: c.aRole(req, epi.ROLES_CONSOLIDATION),
      planification: c.aRole(req, epi.ROLES_PLANIFICATION),
      saisie: c.aRole(req, epi.ROLES_SAISIE),
      separationSaisieValidation: epi.SEPARATION_SAISIE_VALIDATION,
    },
  });
};

// --- Référentiel géographique --------------------------------------------------------------

exports.territoires = async (req, res) => {
  await initialiser();
  const filtre = { actif: req.query.inactifs === 'oui' ? { $in: [true, false] } : true };
  if (req.query.niveau) filtre.niveau = texte(req.query.niveau, 40);
  if (req.query.dans) filtre.chemin = texte(req.query.dans, 80).toUpperCase();
  const entites = await EntiteGeographique.find(filtre).sort({ chemin: 1, nom: 1 }).lean();
  // Ordre arborescent : parent puis enfants (profondeur = longueur du chemin).
  const parParent = new Map();
  for (const e of entites) {
    const k = e.parentCode ?? '';
    if (!parParent.has(k)) parParent.set(k, []);
    parParent.get(k).push(e);
  }
  const ordre = [];
  const codes = new Set(entites.map((e) => e.code));
  const visiter = (k) => (parParent.get(k) ?? []).sort((a, b) => a.nom.localeCompare(b.nom, 'fr')).forEach((e) => { ordre.push(e); visiter(e.code); });
  for (const e of entites) {
    if (e.parentCode && codes.has(e.parentCode)) continue;
    ordre.push(e);
    visiter(e.code);
  }
  res.json(ordre.map((e) => ({
    id: String(e._id), code: e.code, codeOfficiel: e.codeOfficiel, niveau: e.niveau, nom: e.nom, parentCode: e.parentCode,
    profondeur: e.chemin.length - 1, etablissementId: e.etablissementId, actif: e.actif,
  })));
};

/** Création d'une entité (code unique, parent obligatoire sauf le pays). */
exports.creerTerritoire = async (req, res) => {
  await c.exigerParametrage(req);
  await initialiser();
  const d = objet(req.body);
  const niveau = texte(d.niveau, 40);
  if (!epi.NIVEAUX.includes(niveau) || niveau === 'Pays') throw erreur(400, 'Niveau géographique invalide.');
  const nom = texte(d.nom, 160);
  if (!nom) throw erreur(400, 'Le nom de l’entité est obligatoire.');
  const parent = await c.entite(d.parentCode);
  if (epi.NIVEAUX.indexOf(parent.niveau) >= epi.NIVEAUX.indexOf(niveau)) throw erreur(400, `Une entité « ${niveau} » ne peut pas dépendre d’une entité « ${parent.niveau} ».`);
  const code = (texte(d.code, 60) || `${parent.code}-${EntiteGeographique.segment(nom)}`).toUpperCase();
  if (await EntiteGeographique.exists({ code })) throw erreur(409, `Le code ${code} existe déjà : chaque entité doit avoir un code unique.`);
  const etablissementId = niveau === 'Formation sanitaire' ? texte(d.etablissementId, 40) || null : null;
  if (etablissementId && !(await Etablissement.exists({ _id: etablissementId }))) throw erreur(400, 'Établissement introuvable.');
  const e = await EntiteGeographique.create({
    code, codeOfficiel: texte(d.codeOfficiel, 60), niveau, nom, parentCode: parent.code, chemin: [...parent.chemin, code], etablissementId, creePar: c.auteur(req),
  });
  await c.tracer(req, 'epi.territoire', { type: 'entite', id: code }, { operation: 'création', niveau });
  res.status(201).json(e);
};

exports.modifierTerritoire = async (req, res) => {
  await c.exigerParametrage(req);
  const e = await c.entite(req.params.code);
  const d = objet(req.body);
  if (d.nom !== undefined) e.nom = texte(d.nom, 160) || e.nom;
  if (d.codeOfficiel !== undefined) e.codeOfficiel = texte(d.codeOfficiel, 60);
  if (d.actif !== undefined && e.code !== 'CD') e.actif = d.actif === true;
  await e.save();
  await c.tracer(req, 'epi.territoire', { type: 'entite', id: e.code }, { operation: 'modification' });
  res.json(e);
};

/**
 * Crée les entités manquantes à partir des établissements AMI (province, zone, aire, formation
 * sanitaire) : le référentiel suit la carte sanitaire déjà saisie, sans double saisie.
 */
async function synchroniser(auteur) {
  await initialiser();
  const etablissements = await Etablissement.find().select('code nom province zoneSante aireSante').lean();
  let creees = 0;
  const assurer = async (code, niveau, nom, parent, extra = {}) => {
    const existant = await EntiteGeographique.findOne({ $or: [{ code }, ...(extra.etablissementId ? [{ etablissementId: extra.etablissementId }] : [])] });
    if (existant) return existant;
    creees += 1;
    return EntiteGeographique.create({ code, niveau, nom, parentCode: parent.code, chemin: [...parent.chemin, code], creePar: auteur, ...extra });
  };
  const pays = await EntiteGeographique.findOne({ code: 'CD' });
  const S = EntiteGeographique.segment;
  for (const e of etablissements) {
    const province = await assurer(`CD-${S(e.province)}`, 'Province', e.province, pays);
    let parent = province;
    if (e.zoneSante) parent = await assurer(`${province.code}-ZS-${S(e.zoneSante)}`, 'Zone de santé', e.zoneSante, parent);
    if (e.aireSante) parent = await assurer(`${parent.code}-AS-${S(e.aireSante)}`, 'Aire de santé', e.aireSante, parent);
    await assurer(`FOSA-${e.code}`, 'Formation sanitaire', e.nom, parent, { etablissementId: String(e._id), codeOfficiel: e.code });
  }
  return { etablissements: etablissements.length, creees };
}
exports.synchroniser = synchroniser;

exports.synchroniserRoute = async (req, res) => {
  await c.exigerParametrage(req);
  const r = await synchroniser(c.auteur(req));
  await c.tracer(req, 'epi.territoire', { type: 'entite', id: null }, { operation: 'synchronisation', creees: r.creees });
  res.json(r);
};
