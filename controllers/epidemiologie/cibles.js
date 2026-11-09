// Sous-fenêtre 3 — Calcul des populations cibles : population de référence validée × coefficient
// validé et applicable. Le calcul enregistre la formule, les valeurs et les versions utilisées
// (reproductible) ; toute modification de la population ou d'un coefficient produit une nouvelle
// version ; les anciennes restent consultables. Les cibles ne sont jamais additionnées entre
// niveaux géographiques qui se chevauchent.
const mongoose = require('mongoose');
const CalculCible = require('../../models/CalculCible');
const EntiteGeographique = require('../../models/EntiteGeographique');
const { enregistrerNumerote } = require('../../models/validationEpi');
const epi = require('../../config/epidemiologie');
const { variation } = require('../../config/moteurEpidemiologie');
const { erreur, texte, objet } = require('../saisie');
const c = require('./commun');
const { populationValidee } = require('./demographie');
const { coefficientsApplicables } = require('./parametres');

const format = (n) => Number(n).toLocaleString('fr-FR');

/** Résultats d'un calcul pour une population totale et des coefficients { cible: { valeurPct, … } }. */
function calculer(totale, coefficients) {
  const resultats = [];
  const manquantes = [];
  for (const [cible, libelle] of Object.entries(epi.CIBLES)) {
    const coef = coefficients[cible];
    if (!coef) { manquantes.push(cible); continue; }
    const decimal = coef.valeurPct / 100;
    const brute = totale * decimal;
    resultats.push({
      cible, libelle, coefficientCode: coef.code ?? null, coefficientVersion: coef.version ?? null, coefficientId: coef.id ?? null,
      valeurPct: coef.valeurPct,
      formule: `${cible} = Population totale × ${String(decimal).replace('.', ',')} = ${format(totale)} × ${String(coef.valeurPct).replace('.', ',')} %`,
      valeurBrute: Math.round(brute * 1000) / 1000,
      valeur: epi.arrondir(brute),
    });
  }
  return { resultats, manquantes };
}
exports.calculer = calculer;

/** Calcul d'une entité : nécessite une population validée ; réutilise un calcul identique. */
async function calculerEntite(req, e, annee) {
  const pop = await populationValidee(e.code, annee);
  if (!pop) return { entiteCode: e.code, nom: e.nom, erreur: 'Population de référence validée absente pour cette année.' };
  const coefs = await coefficientsApplicables(e.code, annee);
  const { resultats, manquantes } = calculer(pop.totale, coefs);
  if (!resultats.length) return { entiteCode: e.code, nom: e.nom, erreur: 'Aucun coefficient validé applicable à ce territoire et à cette année.' };
  // Même population (version) et mêmes coefficients (versions) : le calcul existant est réutilisé.
  const signature = (r) => r.map((x) => `${x.cible}:${x.coefficientId}`).sort().join('|');
  const existant = await CalculCible.findOne({ entiteCode: e.code, annee, 'population.id': pop.id, statut: { $nin: ['Archivé', 'Rejeté'] }, simulation: false }).sort({ version: -1 });
  if (existant && signature(existant.resultats) === signature(resultats)) return { entiteCode: e.code, nom: e.nom, calcul: existant, reutilise: true };
  const derniere = await CalculCible.findOne({ entiteCode: e.code, annee }).sort({ version: -1 }).select('version').lean();
  const parAge = pop.tranchesAge.map((t) => ({ code: t.code, libelle: t.libelle, effectif: t.effectif }));
  parAge.push({ code: 'F', libelle: 'Femmes (toutes tranches)', effectif: pop.femmes }, { code: 'M', libelle: 'Hommes (toutes tranches)', effectif: pop.hommes });
  const calcul = new CalculCible({
    entiteCode: e.code, annee, version: (derniere?.version ?? 0) + 1,
    population: { id: pop.id, version: pop.version, totale: pop.totale, hommes: pop.hommes, femmes: pop.femmes, nature: pop.nature, source: pop.source },
    resultats, manquantes, parAge, arrondi: epi.ARRONDI, creePar: c.auteur(req),
  });
  calcul.tracer('Calcul', c.auteur(req), { motif: `Population v${pop.version} ; coefficients ${resultats.map((r) => `${r.coefficientCode} v${r.coefficientVersion}`).join(', ')}` });
  await enregistrerNumerote(calcul, `CAL-${annee}`);
  return { entiteCode: e.code, nom: e.nom, calcul };
}

/** Lancement du calcul (entité seule, ou entité et tous ses descendants). */
exports.lancer = async (req, res) => {
  await c.exigerPlanification(req);
  const d = objet(req.body);
  const e = await c.entite(d.entiteCode);
  const annee = c.annee(d.annee);
  const entites = d.inclureDescendants ? await c.descendants(e.code) : [e];
  const resultats = [];
  for (const x of entites.slice(0, 2000)) resultats.push(await calculerEntite(req, x, annee));
  const calcules = resultats.filter((r) => r.calcul && !r.reutilise).length;
  await c.tracer(req, 'epi.calcul', { type: 'calcul', id: e.code }, { annee, entites: entites.length, calcules });
  res.json({
    annee, calcules, reutilises: resultats.filter((r) => r.reutilise).length,
    resultats: resultats.map((r) => ({ entiteCode: r.entiteCode, nom: r.nom, erreur: r.erreur ?? null, reutilise: !!r.reutilise, calcul: r.calcul ?? null })),
  });
};

/** Simulation et recalcul : aucun enregistrement (coefficients saisis ou applicables). */
exports.simuler = async (req, res) => {
  const d = objet(req.body);
  const totale = Number(d.populationTotale);
  if (!Number.isInteger(totale) || totale < 0) throw erreur(400, 'Population totale : nombre entier positif attendu.');
  const annee = c.annee(d.annee);
  let coefs = d.entiteCode ? await coefficientsApplicables(texte(d.entiteCode, 80).toUpperCase(), annee) : {};
  coefs = Object.fromEntries(Object.entries(coefs).map(([k, v]) => [k, v.toJSON()]));
  for (const [cible, valeur] of Object.entries(objet(d.coefficients))) {
    if (!epi.CIBLES[cible] || valeur === '' || valeur == null) continue;
    const v = Number(String(valeur).replace(',', '.'));
    if (!Number.isFinite(v) || v < 0 || v > 100) throw erreur(400, `Coefficient ${cible} invalide.`);
    coefs[cible] = { valeurPct: v, code: 'SIMULATION', version: null, id: null };
  }
  res.json({ simulation: true, populationTotale: totale, arrondi: epi.ARRONDI, ...calculer(totale, coefs) });
};

/** Calcul validé le plus récent d'une entité pour une année (dénominateurs des couvertures). */
const cibleValidee = (entiteCode, annee) => CalculCible.findOne({ entiteCode, annee, statut: 'Validé' }).sort({ version: -1 });
exports.cibleValidee = cibleValidee;

/** Comparaison avec l'année précédente (écart et variation, « non calculable » si absente). */
async function comparaison(calcul) {
  const prec = await cibleValidee(calcul.entiteCode, calcul.annee - 1);
  return Object.keys(epi.CIBLES).map((cible) => {
    const actuelle = calcul.cible(cible);
    const precedente = prec?.cible(cible) ?? null;
    const v = variation(actuelle, precedente);
    return { cible, actuelle, precedente, ecart: actuelle != null && precedente != null ? actuelle - precedente : null, variation: v.valeur, raison: v.raison };
  });
}

exports.lister = async (req, res) => {
  const filtre = {};
  if (req.query.dans) filtre.entiteCode = { $in: (await c.descendants(texte(req.query.dans, 80).toUpperCase())).map((x) => x.code) };
  if (req.query.entite) filtre.entiteCode = texte(req.query.entite, 80).toUpperCase();
  if (req.query.annee) filtre.annee = c.annee(req.query.annee);
  if (req.query.statut) filtre.statut = texte(req.query.statut, 20);
  else if (req.query.archives !== 'oui') filtre.statut = { $ne: 'Archivé' };
  const liste = await CalculCible.find(filtre).sort({ annee: -1, entiteCode: 1, version: -1 }).limit(500);
  const entites = new Map((await EntiteGeographique.find({ code: { $in: liste.map((x) => x.entiteCode) } }).lean()).map((e) => [e.code, e]));
  res.json(liste.map((x) => ({ ...x.toJSON(), territoire: entites.get(x.entiteCode)?.nom ?? x.entiteCode, niveau: entites.get(x.entiteCode)?.niveau ?? null })));
};

exports.obtenir = async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw erreur(404, 'Calcul introuvable.');
  const x = await CalculCible.findById(req.params.id);
  if (!x) throw erreur(404, 'Calcul introuvable.');
  const versions = await CalculCible.find({ entiteCode: x.entiteCode, annee: x.annee }).sort({ version: -1 }).select('numero version statut createdAt resultats population creePar').lean();
  res.json({ ...x.toJSON(), comparaison: await comparaison(x), versions: versions.map((v) => ({ id: String(v._id), numero: v.numero, version: v.version, statut: v.statut, le: v.createdAt, par: v.creePar?.nom, resultats: v.resultats, population: v.population })) });
};

/**
 * Synthèse (graphiques §3.6) : cibles par entité du niveau inférieur (comparaison), évolution sur
 * plusieurs années et écart avec l'année précédente. Le calcul validé est préféré, sinon le plus récent
 * (signalé non validé).
 */
exports.synthese = async (req, res) => {
  const code = req.query.entite ? texte(req.query.entite, 80).toUpperCase() : await c.entiteParDefaut(req);
  const e = await c.entite(code);
  const annee = c.annee(req.query.annee);
  const enfants = await EntiteGeographique.find({ parentCode: code, actif: true }).sort({ nom: 1 }).lean();
  const meilleur = async (entiteCode, a) => (await cibleValidee(entiteCode, a))
    ?? CalculCible.findOne({ entiteCode, annee: a, statut: { $nin: ['Archivé', 'Rejeté'] }, simulation: false }).sort({ version: -1 });
  const courant = await meilleur(code, annee);
  const lignes = [];
  for (const x of enfants) {
    const k = await meilleur(x.code, annee);
    lignes.push({ code: x.code, nom: x.nom, niveau: x.niveau, population: k?.population.totale ?? null, statut: k?.statut ?? 'Non calculé',
      ...Object.fromEntries(Object.keys(epi.CIBLES).map((cb) => [cb, k?.cible(cb) ?? null])) });
  }
  const valides = await CalculCible.find({ entiteCode: code, statut: { $in: ['Validé', 'Archivé'] }, simulation: false }).sort({ annee: 1, version: -1 }).lean();
  const parAnnee = new Map();
  for (const v of valides) if (!parAnnee.has(v.annee) || v.statut === 'Validé') parAnnee.set(v.annee, v);
  res.json({
    entite: { code: e.code, nom: e.nom, niveau: e.niveau }, annee,
    courant: courant ? { ...courant.toJSON(), comparaison: await comparaison(courant) } : null,
    parEntite: lignes,
    evolution: [...parAnnee.values()].map((v) => ({ annee: v.annee, ...Object.fromEntries(v.resultats.map((r) => [r.cible, r.valeur])) })),
    note: 'Les cibles des entités ne sont pas additionnées entre niveaux qui se chevauchent : chaque niveau a son propre calcul.',
  });
};
