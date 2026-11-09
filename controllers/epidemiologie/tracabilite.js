// Sous-fenêtre 10 — Historique, validation et traçabilité : file des données en attente, données
// validées, rejetées ou à corriger, historique des modifications (valeur initiale, nouvelle valeur,
// motif), journal des utilisateurs, historique des calculs et rapports, statistiques de validation.
// Qui a saisi ? Qui a modifié ou validé ? Quelle était la valeur initiale et pourquoi a-t-elle changé ?
const JournalAudit = require('../../models/JournalAudit');
const CalculCible = require('../../models/CalculCible');
const RapportEpi = require('../../models/RapportEpi');
const Etablissement = require('../../models/Etablissement');
const epi = require('../../config/epidemiologie');
const moteur = require('../../config/moteurEpidemiologie');
const { ACTIONS } = require('../../config/audit');
const { texte } = require('../saisie');
const c = require('./commun');

const JOUR = 86400000;
const TYPES = Object.keys(c.REGISTRE);

/** Types demandés (?type=population,coefficient…), tous par défaut. */
const typesDemandes = (q) => (q.type ? String(q.type).split(',').filter((t) => TYPES.includes(t)) : TYPES);

/** Ligne de la file de validation (sans donnée nominative). */
async function ligne(type, d, etabs) {
  const t = c.REGISTRE[type];
  const controle = d.statut === 'Soumis' ? await c.controler(type, d) : null;
  return {
    type, libelleType: t.libelle, id: d.id, reference: d.numero ?? d.code ?? d.id.slice(-6).toUpperCase(), resume: t.resume(d),
    territoire: d.entiteCode ?? null, structure: etabs.get(d.etablissementId) ?? null, periode: t.periode(d), version: d.version, statut: d.statut,
    auteur: d.creePar?.nom ?? null, soumisPar: d.soumission?.par?.nom ?? null, soumisLe: d.soumission?.le ?? null,
    decision: d.decision ?? null, controle,
    peutValider: false,
  };
}

async function lister(req, statuts, limite = 500) {
  const lignes = [];
  for (const type of typesDemandes(req.query)) {
    const { Modele } = c.REGISTRE[type];
    const docs = await Modele.find({ statut: { $in: statuts } }).sort({ updatedAt: -1 }).limit(limite);
    const etabs = new Map((await Etablissement.find({ _id: { $in: [...new Set(docs.map((x) => x.etablissementId).filter(Boolean))] } }).select('nom').lean().catch(() => [])).map((e) => [String(e._id), e.nom]));
    for (const d of docs) lignes.push(await ligne(type, d, etabs));
  }
  const validateur = c.aRole(req, epi.ROLES_VALIDATION);
  for (const l of lignes) {
    l.peutValider = validateur && l.statut === 'Soumis' && !(epi.SEPARATION_SAISIE_VALIDATION && [l.auteur, l.soumisPar].includes(`${req.soignant.prenom} ${req.soignant.nom}`));
  }
  return lignes.sort((a, b) => new Date(b.soumisLe ?? 0) - new Date(a.soumisLe ?? 0));
}

exports.enAttente = async (req, res) => res.json(await lister(req, ['Soumis']));
exports.validees = async (req, res) => res.json(await lister(req, ['Validé'], 200));
exports.rejetees = async (req, res) => res.json(await lister(req, ['Rejeté', 'À corriger'], 300));

/** Historique des modifications de toutes les données du module (ancienne / nouvelle valeur, motif). */
exports.modifications = async (req, res) => {
  const p = req.query.du || req.query.au || req.query.mois || req.query.annee ? c.periode(req.query) : null;
  const debut = p ? moteur.instantJour(p.du) : new Date(Date.now() - 90 * JOUR);
  const fin = p ? new Date(moteur.instantJour(p.au).getTime() + JOUR) : new Date(Date.now() + JOUR);
  const lignes = [];
  for (const type of typesDemandes(req.query)) {
    const { Modele, libelle } = c.REGISTRE[type];
    const docs = await Modele.find({ 'historique.le': { $gte: debut, $lt: fin } }).select('numero code entiteCode historique version').lean();
    for (const d of docs) {
      for (const h of d.historique) {
        if (h.le < debut || h.le >= fin) continue;
        if (req.query.utilisateur && h.par?.id !== req.query.utilisateur) continue;
        const changements = Object.entries(h.changements ?? {}).map(([champ, v]) => ({ champ, avant: v.avant, apres: v.apres }));
        lignes.push({ type, libelleType: libelle, id: String(d._id), reference: d.numero ?? d.code ?? String(d._id).slice(-6).toUpperCase(), territoire: d.entiteCode ?? null,
          operation: h.operation, version: h.version, ancienStatut: h.ancienStatut, nouveauStatut: h.nouveauStatut, changements, motif: h.motif, par: h.par, le: h.le });
      }
    }
  }
  res.json(lignes.sort((a, b) => new Date(b.le) - new Date(a.le)).slice(0, 2000));
};

/** Journal des utilisateurs (opérations du module, consultations nominatives, refus d'accès). */
exports.journal = async (req, res) => {
  const filtre = { $or: [{ action: /^epi\./ }, { action: 'acces.refuse', 'ressource.type': 'epidemiologie' }] };
  if (req.query.utilisateur) filtre['acteur.id'] = texte(req.query.utilisateur, 40);
  if (req.query.action) filtre.action = texte(req.query.action, 60);
  const entrees = await JournalAudit.find(filtre).sort({ le: -1 }).limit(Math.min(Number(req.query.limite) || 500, 2000)).lean();
  await c.tracer(req, 'epi.journal.lecture', { type: 'journal', id: null }, { nombre: entrees.length });
  res.json(entrees.map((e) => ({ id: String(e._id), action: e.action, libelle: ACTIONS[e.action] ?? e.action, acteur: e.acteur, resultat: e.resultat, ressource: e.ressource, details: e.details, le: e.le })));
};

/** Historique des calculs et des rapports (versions, paramètres utilisés, auteurs). */
exports.calculsEtRapports = async (req, res) => {
  const [calculs, rapports] = await Promise.all([
    CalculCible.find().sort({ createdAt: -1 }).limit(300).select('numero entiteCode annee version statut population resultats creePar createdAt simulation').lean(),
    RapportEpi.find().sort({ createdAt: -1 }).limit(300).select('numero type titre version statut generePar createdAt remplacePar regenereDe versions exports validation').lean(),
  ]);
  res.json({
    calculs: calculs.map((k) => ({ id: String(k._id), numero: k.numero, entiteCode: k.entiteCode, annee: k.annee, version: k.version, statut: k.statut, population: `v${k.population?.version} (${k.population?.totale})`,
      coefficients: (k.resultats ?? []).map((r) => `${r.coefficientCode} v${r.coefficientVersion}`).join(', '), par: k.creePar?.nom, le: k.createdAt })),
    rapports: rapports.map((r) => ({ numero: r.numero, type: epi.TYPES_RAPPORT[r.type] ?? r.type, titre: r.titre, version: r.version, statut: r.statut, par: r.generePar?.nom, le: r.createdAt,
      remplacePar: r.remplacePar, regenereDe: r.regenereDe, exports: (r.exports ?? []).length, validePar: r.validation?.responsable ?? null, versions: r.versions })),
  });
};

/**
 * Statistiques (§10.5–10.7) : taux de validation et de rejet, délai moyen de validation, par mois,
 * par type de données et par structure ; volume de corrections ; activité des utilisateurs.
 */
exports.statistiques = async (req, res) => {
  const p = req.query.du || req.query.au || req.query.mois || req.query.annee ? c.periode(req.query) : c.periode({ annee: new Date().getFullYear() });
  const debut = moteur.instantJour(p.du);
  const fin = new Date(moteur.instantJour(p.au).getTime() + JOUR);
  let soumis = 0;
  let valides = 0;
  let rejetes = 0;
  let corrections = 0;
  const delais = [];
  const parType = [];
  const parMois = new Map();
  const rejetsParStructure = new Map();
  const activite = new Map();
  const erreurs = new Map();
  for (const type of TYPES) {
    const { Modele, libelle } = c.REGISTRE[type];
    const docs = await Modele.find({ 'historique.le': { $gte: debut, $lt: fin } }).select('historique etablissementId').lean();
    let s = 0; let v = 0; let r = 0;
    for (const d of docs) {
      let soumisLe = null;
      for (const h of d.historique) {
        const dansP = h.le >= debut && h.le < fin;
        if (h.operation === 'Soumission' || h.operation === 'Notification' || (h.operation === 'Enregistrement' && h.nouveauStatut === 'Soumis') || h.operation === 'Correction') {
          soumisLe = h.le;
          if (dansP) s += 1;
        }
        if (!dansP) continue;
        const m = moteur.jourKinshasa(h.le).slice(0, 7);
        if (!parMois.has(m)) parMois.set(m, { mois: m, valides: 0, rejetes: 0, corrections: 0 });
        if (h.par?.nom) activite.set(h.par.nom, (activite.get(h.par.nom) ?? 0) + 1);
        if (h.operation === 'Validation') {
          v += 1; parMois.get(m).valides += 1;
          if (soumisLe) delais.push((new Date(h.le) - new Date(soumisLe)) / JOUR);
        }
        if (h.operation === 'Rejet' || h.operation === 'Demande de correction') {
          r += 1; parMois.get(m).rejetes += 1;
          const k = d.etablissementId ?? 'Niveau central / non rattaché';
          rejetsParStructure.set(k, (rejetsParStructure.get(k) ?? 0) + 1);
          const motif = (h.motif || 'Sans motif').slice(0, 60);
          erreurs.set(motif, (erreurs.get(motif) ?? 0) + 1);
        }
        if (h.operation === 'Correction' || h.operation === 'Nouvelle version' || h.operation === 'Modification') { corrections += 1; parMois.get(m).corrections += 1; }
      }
    }
    soumis += s; valides += v; rejetes += r;
    parType.push({ type, libelle, soumis: s, valides: v, rejetes: r, tauxValidation: moteur.ratio(v, s).valeur });
  }
  const noms = new Map((await Etablissement.find({ _id: { $in: [...rejetsParStructure.keys()].filter((k) => /^[a-f0-9]{24}$/.test(k)) } }).select('nom').lean()).map((e) => [String(e._id), e.nom]));
  res.json({
    periode: p,
    soumis, valides, rejetes, corrections,
    tauxValidation: { ...moteur.ratio(valides, soumis), formule: 'Enregistrements validés ÷ enregistrements soumis × 100' },
    tauxRejet: { ...moteur.ratio(rejetes, soumis), formule: 'Enregistrements rejetés (ou renvoyés en correction) ÷ enregistrements soumis × 100' },
    delaiMoyenValidationJours: delais.length ? Math.round((delais.reduce((s, x) => s + x, 0) / delais.length) * 10) / 10 : null,
    parType, parMois: [...parMois.values()].sort((a, b) => a.mois.localeCompare(b.mois)),
    rejetsParStructure: [...rejetsParStructure.entries()].map(([k, n]) => ({ structure: noms.get(k) ?? k, n })).sort((a, b) => b.n - a.n),
    activite: [...activite.entries()].map(([nom, n]) => ({ nom, n })).sort((a, b) => b.n - a.n).slice(0, 20),
    erreurs: [...erreurs.entries()].map(([motif, n]) => ({ motif, n })).sort((a, b) => b.n - a.n).slice(0, 15),
  });
};
