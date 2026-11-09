const mongoose = require('mongoose');
const { versJson } = require('./commun');
const { validationEpi } = require('./validationEpi');
const { SOURCES_DEMOGRAPHIQUES, METHODES, NATURES } = require('../config/epidemiologie');

const entier = (requis = false) => ({ type: Number, min: 0, default: requis ? undefined : null, required: requis,
  validate: { validator: (v) => v == null || Number.isInteger(v), message: 'Nombre entier attendu.' } });

/**
 * Sous-fenêtre 1 — population de référence d'une entité géographique pour une année.
 * Une seule version active (non archivée, non rejetée) par entité et par année ; une nouvelle
 * population de référence crée une nouvelle version, l'ancienne reste consultable.
 */
const populationSchema = new mongoose.Schema({
  entiteCode: { type: String, required: true, index: true },
  annee: { type: Number, required: true, min: 1950, max: 2100 },
  totale: entier(true),
  hommes: entier(true),
  femmes: entier(true),
  urbaine: entier(),
  rurale: entier(),
  /** Répartition par tranche d'âge (codes de config/epidemiologie.js ou groupes spécifiques PEV). */
  tranchesAge: {
    type: [new mongoose.Schema({ code: { type: String, required: true }, libelle: String, effectif: entier(true) }, { _id: false })],
    default: [],
  },
  source: { type: String, enum: SOURCES_DEMOGRAPHIQUES, required: true },
  methode: { type: String, enum: METHODES, required: true },
  nature: { type: String, enum: NATURES, default: 'Estimée' },
  dateDisponibilite: { type: String, required: true },
  /** Référence du document justificatif (titre, numéro, lien). */
  document: { type: String, default: '', trim: true },
  commentaire: { type: String, default: '', trim: true },
}, { timestamps: true, toJSON: { transform: versJson } });

populationSchema.plugin(validationEpi, {
  champs: ['totale', 'hommes', 'femmes', 'urbaine', 'rurale', 'tranchesAge', 'source', 'methode', 'nature', 'dateDisponibilite', 'document'],
});
populationSchema.index({ entiteCode: 1, annee: 1, version: 1 }, { unique: true });

/** Anomalies de cohérence (calculs 1 et 4 du §1.4), vides si la saisie est cohérente. */
populationSchema.methods.anomalies = function () {
  const a = [];
  if (this.hommes + this.femmes !== this.totale) a.push(`Hommes + femmes (${this.hommes + this.femmes}) ≠ population totale (${this.totale}).`);
  if (this.urbaine != null && this.rurale != null && this.urbaine + this.rurale !== this.totale) a.push(`Urbaine + rurale (${this.urbaine + this.rurale}) ≠ population totale (${this.totale}).`);
  if (this.tranchesAge.length) {
    const somme = this.tranchesAge.reduce((s, t) => s + t.effectif, 0);
    if (somme !== this.totale) a.push(`Somme des tranches d’âge (${somme}) ≠ population totale (${this.totale}) : groupes manquants ou âges non renseignés.`);
  } else a.push('Répartition par âge non renseignée.');
  return a;
};

module.exports = mongoose.model('PopulationReference', populationSchema, 'epi_populations');
