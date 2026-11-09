// Sous-fenêtre 1 — Référentiel démographique : populations de référence par entité et par année,
// contrôles de cohérence (sexe, âge), versions, validation et synthèses (graphiques).
const mongoose = require('mongoose');
const PopulationReference = require('../../models/PopulationReference');
const EntiteGeographique = require('../../models/EntiteGeographique');
const epi = require('../../config/epidemiologie');
const { ratio } = require('../../config/moteurEpidemiologie');
const { erreur, texte, objet, jour } = require('../saisie');
const c = require('./commun');

const entierOuNull = (v, libelle, requis = false) => {
  if (v === '' || v == null) {
    if (requis) throw erreur(400, `${libelle} : valeur obligatoire.`);
    return null;
  }
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0) throw erreur(400, `${libelle} : nombre entier positif attendu.`);
  return n;
};

/** Champs acceptés (liste blanche). */
function lire(d, partiel = false) {
  const o = {};
  const prendre = (k) => !partiel || d[k] !== undefined;
  if (prendre('totale')) o.totale = entierOuNull(d.totale, 'Population totale', true);
  if (prendre('hommes')) o.hommes = entierOuNull(d.hommes, 'Population masculine', true);
  if (prendre('femmes')) o.femmes = entierOuNull(d.femmes, 'Population féminine', true);
  if (d.urbaine !== undefined) o.urbaine = entierOuNull(d.urbaine, 'Population urbaine');
  if (d.rurale !== undefined) o.rurale = entierOuNull(d.rurale, 'Population rurale');
  if (d.tranchesAge !== undefined) {
    if (!Array.isArray(d.tranchesAge)) throw erreur(400, 'Répartition par âge invalide.');
    const vus = new Set();
    o.tranchesAge = d.tranchesAge.filter((t) => t && t.effectif !== '' && t.effectif != null).slice(0, 40).map((t) => {
      const code = texte(t.code, 20);
      if (!code || vus.has(code)) throw erreur(400, 'Tranche d’âge en double ou sans code.');
      vus.add(code);
      const ref = epi.TRANCHES_AGE.find((x) => x.code === code);
      return { code, libelle: texte(t.libelle, 80) || ref?.libelle || code, effectif: entierOuNull(t.effectif, `Tranche ${code}`, true) };
    });
  }
  for (const [k, liste, libelle, requis] of [
    ['source', epi.SOURCES_DEMOGRAPHIQUES, 'Source démographique', true], ['methode', epi.METHODES, 'Méthode utilisée', true], ['nature', epi.NATURES, 'Nature', false],
  ]) {
    if (d[k] === undefined || d[k] === '') {
      if (requis && !partiel) throw erreur(400, `${libelle} : valeur obligatoire.`);
      continue;
    }
    if (!liste.includes(d[k])) throw erreur(400, `${libelle} invalide.`);
    o[k] = d[k];
  }
  if (prendre('dateDisponibilite')) {
    o.dateDisponibilite = jour(d.dateDisponibilite, 'Date de disponibilité');
    if (!o.dateDisponibilite) throw erreur(400, 'Date de disponibilité obligatoire.');
  }
  if (d.document !== undefined) o.document = texte(d.document, 500);
  if (d.commentaire !== undefined) o.commentaire = texte(d.commentaire, 2000);
  return o;
}

/** Vue d'une population : proportions (calculs 2 et 3) et anomalies (calculs 1 et 4). */
function vue(p, entites = new Map()) {
  const j = p.toJSON();
  return {
    ...j,
    territoire: entites.get(p.entiteCode)?.nom ?? p.entiteCode,
    niveau: entites.get(p.entiteCode)?.niveau ?? null,
    proportionHommes: ratio(p.hommes, p.totale).valeur,
    proportionFemmes: ratio(p.femmes, p.totale).valeur,
    anomalies: p.anomalies(),
  };
}

async function carteEntites(codes) {
  return new Map((await EntiteGeographique.find({ code: { $in: [...new Set(codes)] } }).lean()).map((e) => [e.code, e]));
}

exports.lister = async (req, res) => {
  const filtre = {};
  if (req.query.dans) filtre.entiteCode = { $in: (await c.descendants(texte(req.query.dans, 80).toUpperCase())).map((e) => e.code) };
  if (req.query.entite) filtre.entiteCode = texte(req.query.entite, 80).toUpperCase();
  if (req.query.annee) filtre.annee = c.annee(req.query.annee);
  if (req.query.statut) filtre.statut = texte(req.query.statut, 20);
  else if (req.query.archives !== 'oui') filtre.statut = { $ne: 'Archivé' };
  const liste = await PopulationReference.find(filtre).sort({ annee: -1, entiteCode: 1, version: -1 }).limit(500);
  const entites = await carteEntites(liste.map((p) => p.entiteCode));
  res.json(liste.map((p) => vue(p, entites)));
};

async function trouver(id) {
  if (!mongoose.isValidObjectId(id)) throw erreur(404, 'Population introuvable.');
  const p = await PopulationReference.findById(id);
  if (!p) throw erreur(404, 'Population introuvable.');
  return p;
}

exports.obtenir = async (req, res) => {
  const p = await trouver(req.params.id);
  res.json(vue(p, await carteEntites([p.entiteCode])));
};

exports.creer = async (req, res) => {
  await c.exigerPlanification(req);
  const d = objet(req.body);
  const e = await c.entite(d.entiteCode);
  const annee = c.annee(d.annee);
  // Une même entité n'a pas deux enregistrements actifs pour la même année.
  const actif = await PopulationReference.findOne({ entiteCode: e.code, annee, statut: { $in: ['Brouillon', 'Soumis', 'À corriger', 'Validé'] } }).sort({ version: -1 });
  if (actif) throw erreur(409, `Une population ${annee} existe déjà pour ${e.nom} (v${actif.version}, ${actif.statut}) : modifiez-la (une donnée validée produit une nouvelle version).`);
  const derniere = await PopulationReference.findOne({ entiteCode: e.code, annee }).sort({ version: -1 }).select('version').lean();
  const p = new PopulationReference({ ...lire(d), entiteCode: e.code, annee, version: (derniere?.version ?? 0) + 1, creePar: c.auteur(req) });
  p.tracer('Création', c.auteur(req));
  await p.validate().catch((err) => { throw erreur(400, require('../../config/erreursFr').messageValidation(err)); });
  await p.save();
  await c.tracer(req, 'epi.population', { type: 'population', id: p.id }, { operation: 'création', entite: e.code, annee });
  res.status(201).json(vue(p, await carteEntites([p.entiteCode])));
};

exports.modifier = async (req, res) => {
  await c.exigerPlanification(req);
  const p = await trouver(req.params.id);
  const d = objet(req.body);
  const champs = lire(d, true);
  const r = await c.modifier(req, 'population', p, (doc) => Object.assign(doc, champs), d.motif);
  await c.tracer(req, 'epi.population', { type: 'population', id: r.id }, { operation: 'modification', version: r.version });
  res.json(vue(r, await carteEntites([r.entiteCode])));
};

/** Population validée d'une entité pour une année (utilisée par le moteur de calcul). */
const populationValidee = (entiteCode, annee) => PopulationReference.findOne({ entiteCode, annee, statut: 'Validé' }).sort({ version: -1 });
exports.populationValidee = populationValidee;

/**
 * Synthèse pour les graphiques (§1.6) : répartition hommes / femmes, histogramme par âge,
 * évolution par année, distribution entre les entités du niveau inférieur. Le contrôle
 * « somme des niveaux inférieurs » signale un risque de double comptage sans additionner.
 */
exports.synthese = async (req, res) => {
  const code = req.query.entite ? texte(req.query.entite, 80).toUpperCase() : await c.entiteParDefaut(req);
  const e = await c.entite(code);
  const annee = c.annee(req.query.annee);
  const [courante, historique, enfants] = await Promise.all([
    PopulationReference.findOne({ entiteCode: code, annee, statut: { $ne: 'Archivé' } }).sort({ version: -1 }),
    PopulationReference.find({ entiteCode: code, statut: 'Validé' }).sort({ annee: 1 }).select('annee totale hommes femmes nature').lean(),
    EntiteGeographique.find({ parentCode: code, actif: true }).lean(),
  ]);
  const popEnfants = await PopulationReference.find({ entiteCode: { $in: enfants.map((x) => x.code) }, annee, statut: { $ne: 'Archivé' } }).sort({ version: -1 });
  const parEnfant = new Map();
  for (const p of popEnfants) if (!parEnfant.has(p.entiteCode)) parEnfant.set(p.entiteCode, p);
  const distribution = enfants.map((x) => {
    const p = parEnfant.get(x.code);
    return { code: x.code, nom: x.nom, niveau: x.niveau, totale: p?.totale ?? null, statut: p?.statut ?? 'Non renseignée' };
  });
  const sommeEnfants = distribution.reduce((s, x) => s + (x.totale ?? 0), 0);
  const renseignes = distribution.filter((x) => x.totale != null).length;
  res.json({
    entite: { code: e.code, nom: e.nom, niveau: e.niveau },
    annee,
    population: courante ? vue(courante, new Map([[e.code, e]])) : null,
    sexe: courante ? [{ libelle: 'Hommes', n: courante.hommes }, { libelle: 'Femmes', n: courante.femmes }] : [],
    ages: courante ? courante.tranchesAge.map((t) => ({ code: t.code, libelle: t.libelle, n: t.effectif })) : [],
    evolution: historique.map((h) => ({ annee: h.annee, totale: h.totale, nature: h.nature })),
    distribution,
    controleNiveaux: courante && renseignes
      ? {
        sommeNiveauInferieur: sommeEnfants, renseignes, total: distribution.length,
        ecart: courante.totale - sommeEnfants,
        message: sommeEnfants > courante.totale
          ? 'La somme des populations du niveau inférieur dépasse la population de référence : chevauchement possible (double comptage).'
          : renseignes < distribution.length ? 'Toutes les entités du niveau inférieur ne sont pas renseignées.' : null,
      }
      : null,
  });
};
