// Mécanisme commun de validation et de traçabilité du module Épidémiologie (Partie I §3,
// sous-fenêtre 10). Chaque enregistrement porte un statut, une version, ses auteurs et
// l'historique de ses valeurs : on sait qui a saisi, qui a modifié ou validé, la valeur initiale
// et pourquoi elle a changé. Une donnée validée n'est jamais écrasée sans historique.
const mongoose = require('mongoose');
const { auteurSchema } = require('./commun');
const { STATUTS } = require('../config/epidemiologie');

const sansId = { _id: false };

/** Entrée d'historique : opération, valeurs avant / après (champs de contenu seulement), motif. */
const historiqueSchema = new mongoose.Schema({
  operation: { type: String, required: true },
  version: { type: Number, required: true },
  ancienStatut: { type: String, default: null },
  nouveauStatut: { type: String, default: null },
  /** Champs modifiés : { champ: { avant, apres } }. */
  changements: { type: mongoose.Schema.Types.Mixed, default: undefined },
  motif: { type: String, default: '' },
  par: { type: auteurSchema, required: true },
  le: { type: Date, default: Date.now },
}, sansId);

/**
 * Greffon de schéma : statut commun, version, auteurs, soumission, décision et historique.
 * `champs` : champs de contenu suivis dans l'historique (avant / après).
 */
function validationEpi(schema, { champs = [] } = {}) {
  schema.add({
    statut: { type: String, enum: STATUTS, default: 'Brouillon', index: true },
    version: { type: Number, default: 1 },
    creePar: { type: auteurSchema, required: true },
    modifiePar: { type: auteurSchema, default: undefined },
    soumission: { type: new mongoose.Schema({ par: auteurSchema, le: Date }, sansId), default: undefined },
    decision: {
      type: new mongoose.Schema({ decision: String, motif: String, par: auteurSchema, le: Date, controle: String }, sansId),
      default: undefined,
    },
    /** Version précédente remplacée par celle-ci (nouvelle version d'une donnée validée). */
    remplace: { type: mongoose.Schema.Types.ObjectId, default: null },
    historique: { type: [historiqueSchema], default: [] },
  });
  schema.statics.CHAMPS_SUIVIS = champs;

  /** Valeurs des champs suivis (instantané pour l'historique). */
  schema.methods.instantane = function () {
    return Object.fromEntries(champs.map((k) => {
      const v = this.get(k);
      return [k, v?.toObject ? v.toObject() : v];
    }));
  };

  /** Ajoute une entrée d'historique (changements = différences avec l'instantané `avant`). */
  schema.methods.tracer = function (operation, par, { avant = null, motif = '', ancienStatut = null } = {}) {
    let changements;
    if (avant) {
      const apres = this.instantane();
      changements = {};
      for (const k of champs) {
        if (JSON.stringify(avant[k] ?? null) !== JSON.stringify(apres[k] ?? null)) changements[k] = { avant: avant[k] ?? null, apres: apres[k] ?? null };
      }
      if (!Object.keys(changements).length) changements = undefined;
    }
    this.historique.push({ operation, version: this.version, ancienStatut, nouveauStatut: this.statut, changements, motif, par, le: new Date() });
  };
}

/**
 * Numéro lisible suivant : PREFIXE-000001 (l'index unique du champ protège des collisions ;
 * l'appelant réessaie en cas de conflit, voir enregistrerNumerote).
 */
async function numeroSuivant(Modele, prefixe, champ = 'numero') {
  const re = new RegExp(`^${prefixe}-\\d+$`);
  const dernier = await Modele.findOne({ [champ]: re }).sort({ [champ]: -1 }).select(champ).lean();
  const n = dernier ? parseInt(dernier[champ].slice(prefixe.length + 1), 10) || 0 : 0;
  return `${prefixe}-${String(n + 1).padStart(6, '0')}`;
}

/** Premier enregistrement avec un numéro séquentiel (refait si deux créations simultanées se croisent). */
async function enregistrerNumerote(doc, prefixe, champ = 'numero') {
  for (let essai = 0; essai < 5; essai += 1) {
    doc[champ] = await numeroSuivant(doc.constructor, prefixe, champ);
    try {
      return await doc.save();
    } catch (err) {
      if (err.code !== 11000 || !err.keyPattern?.[champ]) throw err;
    }
  }
  throw new Error(`Numéro ${prefixe} impossible à attribuer.`);
}

module.exports = { validationEpi, historiqueSchema, numeroSuivant, enregistrerNumerote };
