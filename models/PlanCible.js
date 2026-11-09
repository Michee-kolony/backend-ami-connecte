const mongoose = require('mongoose');
const { versJson } = require('./commun');
const { validationEpi } = require('./validationEpi');

const sansId = { _id: false };
const entiers = (n) => ({
  type: [Number],
  validate: { validator: (v) => v.length === n && v.every((x) => Number.isInteger(x) && x >= 0), message: `${n} objectifs entiers positifs attendus.` },
});

/**
 * Sous-fenêtre 4 — plan d'une intervention pour une entité et une année : cible annuelle issue
 * du calcul validé (ou d'un ajustement documenté), répartition mensuelle (la somme est égale à la
 * cible annuelle) et répartition géographique entre les entités du niveau inférieur.
 */
const planSchema = new mongoose.Schema({
  /** Numéro du plan, conservé d'une version à l'autre (unique avec la version). */
  numero: { type: String, required: true },
  annee: { type: Number, required: true },
  intervention: { type: String, required: true },
  entiteCode: { type: String, required: true, index: true },
  /** Calcul de la sous-fenêtre 3 d'où vient la cible (numéro et version). */
  calcul: { type: new mongoose.Schema({ numero: String, version: Number, cible: String, valeur: Number }, sansId), default: undefined },
  cibleAnnuelle: { type: Number, required: true, min: 0 },
  /** Cible révisée : différente du calcul, justifiée. */
  ajustee: { type: Boolean, default: false },
  repartition: { type: String, enum: ['Uniforme', 'Personnalisée'], default: 'Uniforme' },
  mensuel: entiers(12),
  /** Répartition entre entités du niveau inférieur (zones, aires, formations sanitaires). */
  geographique: {
    type: [new mongoose.Schema({ entiteCode: String, nom: String, cible: { type: Number, min: 0 } }, sansId)],
    default: [],
  },
  responsable: { type: String, default: '', trim: true },
  justification: { type: String, default: '', trim: true },
}, { timestamps: true, toJSON: { transform: versJson } });

planSchema.plugin(validationEpi, { champs: ['cibleAnnuelle', 'ajustee', 'repartition', 'mensuel', 'geographique', 'responsable', 'justification'] });
planSchema.index({ numero: 1, version: 1 }, { unique: true });
planSchema.index({ annee: 1, intervention: 1, entiteCode: 1 });

/** Objectifs trimestriels : somme des trois mois. */
planSchema.virtual('trimestriel').get(function () {
  return [0, 1, 2, 3].map((t) => this.mensuel.slice(t * 3, t * 3 + 3).reduce((s, x) => s + x, 0));
});
planSchema.set('toJSON', { virtuals: true, transform: versJson });

module.exports = mongoose.model('PlanCible', planSchema, 'epi_plans');
