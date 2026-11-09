// Sous-fenêtre 4 — Planification et répartition des cibles : la cible annuelle vient du calcul
// validé (ou d'un ajustement documenté), répartie par mois et trimestre (somme = cible annuelle)
// et entre les entités du niveau inférieur ; suivi des réalisations observées dans les modules AMI.
// Une cible n'est jamais une réalisation : cible planifiée, cible révisée et réalisation sont distinctes.
const mongoose = require('mongoose');
const PlanCible = require('../../models/PlanCible');
const EntiteGeographique = require('../../models/EntiteGeographique');
const { enregistrerNumerote } = require('../../models/validationEpi');
const epi = require('../../config/epidemiologie');
const moteur = require('../../config/moteurEpidemiologie');
const { erreur, texte, objet } = require('../saisie');
const c = require('./commun');
const { cibleValidee } = require('./cibles');
const { fichesIndicateurs } = require('./parametres');

/** Répartition uniforme en entiers dont la somme est exactement la cible annuelle. */
function repartirUniforme(total, n = 12) {
  const base = Math.floor(total / n);
  const reste = total - base * n;
  return Array.from({ length: n }, (_, i) => base + (i < reste ? 1 : 0));
}
exports.repartirUniforme = repartirUniforme;

/** Code de réalisation (moteur) d'une intervention ; CPN4 = nombre de contacts requis de la fiche. */
async function realisationDe(intervention) {
  if (intervention !== 'CPN4') return { code: intervention, contactsCpnRequis: 4 };
  const fiche = (await fichesIndicateurs()).find((f) => f.intervention === 'CPN4');
  return { code: 'CPN_REQUIS', contactsCpnRequis: Number(fiche?.parametres?.contactsRequis) || 4 };
}
exports.realisationDe = realisationDe;

function lireMensuel(v) {
  if (!Array.isArray(v) || v.length !== 12) throw erreur(400, 'Douze objectifs mensuels attendus.');
  return v.map((x, i) => {
    const n = Number(x);
    if (!Number.isInteger(n) || n < 0) throw erreur(400, `Objectif du mois ${i + 1} : entier positif attendu.`);
    return n;
  });
}

async function lireGeographique(v, parent) {
  if (!Array.isArray(v)) throw erreur(400, 'Répartition géographique invalide.');
  const enfants = new Map((await EntiteGeographique.find({ chemin: parent, code: { $ne: parent } }).lean()).map((e) => [e.code, e]));
  const vus = new Set();
  return v.slice(0, 500).map((l) => {
    const code = texte(l?.entiteCode, 80).toUpperCase();
    const e = enfants.get(code);
    if (!e || vus.has(code)) throw erreur(400, `Entité ${code || '?'} absente du territoire du plan ou répétée.`);
    vus.add(code);
    const n = Number(l.cible);
    if (!Number.isInteger(n) || n < 0) throw erreur(400, `Cible de ${e.nom} : entier positif attendu.`);
    return { entiteCode: code, nom: e.nom, cible: n };
  });
}

exports.creer = async (req, res) => {
  await c.exigerPlanification(req);
  const d = objet(req.body);
  const e = await c.entite(d.entiteCode);
  const annee = c.annee(d.annee);
  const intervention = epi.PAR_INTERVENTION.get(d.intervention);
  if (!intervention) throw erreur(400, 'Intervention invalide.');
  const actif = await PlanCible.findOne({ annee, intervention: intervention.code, entiteCode: e.code, statut: { $nin: ['Archivé', 'Rejeté'] } }).select('numero version statut').lean();
  if (actif) throw erreur(409, `Un plan ${intervention.libelle} ${annee} existe déjà pour ${e.nom} (${actif.numero} v${actif.version}, ${actif.statut}).`);
  const calcul = await cibleValidee(e.code, annee);
  const calculee = calcul?.cible(intervention.cible) ?? null;
  const saisie = d.cibleAnnuelle === '' || d.cibleAnnuelle == null ? null : Number(d.cibleAnnuelle);
  if (saisie != null && (!Number.isInteger(saisie) || saisie < 0)) throw erreur(400, 'Cible annuelle : entier positif attendu.');
  const cibleAnnuelle = saisie ?? calculee;
  if (cibleAnnuelle == null) throw erreur(400, `Aucun calcul validé de « ${epi.CIBLES[intervention.cible]} » pour ${e.nom} en ${annee} : validez d’abord les populations cibles (sous-fenêtre 3), ou saisissez une cible ajustée et justifiée.`);
  const ajustee = calculee == null || saisie != null && saisie !== calculee;
  const justification = texte(d.justification, 2000);
  if (ajustee && !justification) throw erreur(400, 'Cible différente du calcul validé : la justification de l’ajustement est obligatoire.');
  const personnalisee = d.repartition === 'Personnalisée';
  const mensuel = personnalisee ? lireMensuel(d.mensuel) : repartirUniforme(cibleAnnuelle);
  if (personnalisee && !justification) throw erreur(400, 'Une répartition non uniforme (saisonnalité, campagnes…) doit être justifiée.');
  const plan = new PlanCible({
    annee, intervention: intervention.code, entiteCode: e.code, cibleAnnuelle, ajustee, repartition: personnalisee ? 'Personnalisée' : 'Uniforme', mensuel,
    calcul: calcul ? { numero: calcul.numero, version: calcul.version, cible: intervention.cible, valeur: calculee } : undefined,
    geographique: d.geographique ? await lireGeographique(d.geographique, e.code) : [],
    responsable: texte(d.responsable, 160), justification, creePar: c.auteur(req),
  });
  plan.tracer('Création', c.auteur(req));
  await plan.validate({ pathsToSkip: ['numero'] }).catch((err) => { throw erreur(400, require('../../config/erreursFr').messageValidation(err)); });
  await enregistrerNumerote(plan, `PLN-${annee}`);
  await c.tracer(req, 'epi.plan', { type: 'plan', id: plan.id }, { operation: 'création', intervention: plan.intervention, entite: e.code });
  res.status(201).json(plan);
};

async function trouver(id) {
  if (!mongoose.isValidObjectId(id)) throw erreur(404, 'Plan introuvable.');
  const p = await PlanCible.findById(id);
  if (!p) throw erreur(404, 'Plan introuvable.');
  return p;
}

/** Réajustement (une cible validée n'est jamais modifiée silencieusement : nouvelle version). */
exports.modifier = async (req, res) => {
  await c.exigerPlanification(req);
  const p = await trouver(req.params.id);
  const d = objet(req.body);
  const champs = {};
  if (d.cibleAnnuelle !== undefined) {
    const n = Number(d.cibleAnnuelle);
    if (!Number.isInteger(n) || n < 0) throw erreur(400, 'Cible annuelle : entier positif attendu.');
    champs.cibleAnnuelle = n;
    champs.ajustee = p.calcul?.valeur == null || n !== p.calcul.valeur;
  }
  if (d.repartition !== undefined) champs.repartition = d.repartition === 'Personnalisée' ? 'Personnalisée' : 'Uniforme';
  if (d.mensuel !== undefined) champs.mensuel = lireMensuel(d.mensuel);
  if (d.geographique !== undefined) champs.geographique = await lireGeographique(d.geographique, p.entiteCode);
  if (d.responsable !== undefined) champs.responsable = texte(d.responsable, 160);
  if (d.justification !== undefined) champs.justification = texte(d.justification, 2000);
  const r = await c.modifier(req, 'plan', p, (doc) => {
    Object.assign(doc, champs);
    if (doc.repartition === 'Uniforme' && d.mensuel === undefined) doc.mensuel = repartirUniforme(doc.cibleAnnuelle);
  }, d.motif);
  await c.tracer(req, 'epi.plan', { type: 'plan', id: r.id }, { operation: 'modification', version: r.version });
  res.json(r);
};

/** Proposition de répartition géographique : cible calculée (validée) de chaque entité enfant. */
exports.propositionGeographique = async (req, res) => {
  const p = await trouver(req.params.id);
  const intervention = epi.PAR_INTERVENTION.get(p.intervention);
  const enfants = await EntiteGeographique.find({ parentCode: p.entiteCode, actif: true }).sort({ nom: 1 }).lean();
  const lignes = [];
  for (const e of enfants) {
    const k = await cibleValidee(e.code, p.annee);
    lignes.push({ entiteCode: e.code, nom: e.nom, niveau: e.niveau, cible: k?.cible(intervention.cible) ?? null });
  }
  const somme = lignes.reduce((s, l) => s + (l.cible ?? 0), 0);
  res.json({ lignes, somme, cibleAnnuelle: p.cibleAnnuelle, ecart: p.cibleAnnuelle - somme });
};

exports.lister = async (req, res) => {
  const filtre = {};
  if (req.query.dans) filtre.entiteCode = { $in: (await c.descendants(texte(req.query.dans, 80).toUpperCase())).map((x) => x.code) };
  if (req.query.entite) filtre.entiteCode = texte(req.query.entite, 80).toUpperCase();
  if (req.query.annee) filtre.annee = c.annee(req.query.annee);
  if (req.query.intervention) filtre.intervention = texte(req.query.intervention, 20);
  if (req.query.statut) filtre.statut = texte(req.query.statut, 20);
  else if (req.query.archives !== 'oui') filtre.statut = { $ne: 'Archivé' };
  const liste = await PlanCible.find(filtre).sort({ annee: -1, entiteCode: 1, intervention: 1, version: -1 }).limit(500);
  const entites = new Map((await EntiteGeographique.find({ code: { $in: liste.map((x) => x.entiteCode) } }).lean()).map((e) => [e.code, e]));
  res.json(liste.map((x) => ({ ...x.toJSON(), territoire: entites.get(x.entiteCode)?.nom ?? x.entiteCode, libelleIntervention: epi.PAR_INTERVENTION.get(x.intervention)?.libelle })));
};

/** Suivi d'un plan : réalisations mensuelles, taux de réalisation, écart, cumul et cible restante. */
async function suiviPlan(req, p) {
  const { etablissementIds, restreint } = await c.perimetre(req, p.entiteCode);
  const { code, contactsCpnRequis } = await realisationDe(p.intervention);
  const r = await moteur.realisations({ etablissementIds, du: `${p.annee}-01-01`, au: `${p.annee}-12-31`, contactsCpnRequis });
  let cumulCible = 0;
  let cumulReal = 0;
  const moisCourant = moteur.jourKinshasa(new Date()).slice(0, 7);
  const mois = r.mois.map((k, i) => {
    const realise = k <= moisCourant ? r.parMois[k][code] : null;
    cumulCible += p.mensuel[i];
    if (realise != null) cumulReal += realise;
    return {
      mois: k, cible: p.mensuel[i], realisations: realise,
      taux: realise == null ? null : moteur.ratio(realise, p.mensuel[i]).valeur,
      ecart: realise == null ? null : realise - p.mensuel[i],
      cumulCible, cumulRealisations: realise == null ? null : cumulReal,
    };
  });
  return {
    plan: p.toJSON(), restreint, etablissements: etablissementIds.length, codeRealisation: code,
    realisationsCumulees: cumulReal,
    tauxAnnuel: moteur.ratio(cumulReal, p.cibleAnnuelle).valeur,
    cibleRestante: Math.max(0, p.cibleAnnuelle - cumulReal),
    trimestres: [0, 1, 2, 3].map((t) => {
      const ms = mois.slice(t * 3, t * 3 + 3);
      const cible = ms.reduce((s, m) => s + m.cible, 0);
      const reals = ms.filter((m) => m.realisations != null);
      const real = reals.length ? reals.reduce((s, m) => s + m.realisations, 0) : null;
      return { trimestre: `T${t + 1}`, cible, realisations: real, taux: real == null ? null : moteur.ratio(real, cible).valeur };
    }),
    mois,
    formule: 'Taux de réalisation = réalisations ÷ cible de la période × 100 ; cible restante = max(0, cible annuelle − réalisations cumulées).',
  };
}
exports.suiviPlan = suiviPlan;

exports.suivi = async (req, res) => {
  res.json(await suiviPlan(req, await trouver(req.params.id)));
};

/**
 * Tableau des structures (§4.5) : pour une intervention et un mois, chaque plan actif du territoire
 * (entité et descendants) avec sa cible annuelle, sa cible du mois, les réalisations et le taux.
 */
exports.tableau = async (req, res) => {
  const code = req.query.entite ? texte(req.query.entite, 80).toUpperCase() : await c.entiteParDefaut(req);
  const annee = c.annee(req.query.annee);
  const intervention = texte(req.query.intervention, 20) || 'CPN1';
  const mois = /^\d{4}-\d{2}$/.test(req.query.mois ?? '') ? req.query.mois : `${annee}-${moteur.jourKinshasa(new Date()).slice(5, 7)}`;
  const entites = await c.descendants(code);
  const plans = await PlanCible.find({ annee, intervention, entiteCode: { $in: entites.map((e) => e.code) }, statut: { $nin: ['Archivé', 'Rejeté'] } }).sort({ version: -1 });
  const vus = new Set();
  const { code: codeReal, contactsCpnRequis } = await realisationDe(intervention);
  const lignes = [];
  for (const p of plans) {
    if (vus.has(p.entiteCode)) continue;
    vus.add(p.entiteCode);
    const e = entites.find((x) => x.code === p.entiteCode);
    const { etablissementIds } = await c.perimetre(req, p.entiteCode);
    const r = await moteur.realisations({ etablissementIds, du: `${mois}-01`, au: `${mois}-${new Date(Date.UTC(+mois.slice(0, 4), +mois.slice(5, 7), 0)).getUTCDate()}`, contactsCpnRequis });
    const cibleMois = p.mensuel[Number(mois.slice(5, 7)) - 1];
    const realise = r.total[codeReal];
    lignes.push({ planId: p.id, numero: p.numero, entiteCode: p.entiteCode, nom: e?.nom ?? p.entiteCode, niveau: e?.niveau, statut: p.statut,
      cibleAnnuelle: p.cibleAnnuelle, cibleMensuelle: cibleMois, realisations: realise, taux: moteur.ratio(realise, cibleMois).valeur, ecart: realise - cibleMois });
  }
  res.json({ annee, mois, intervention, lignes });
};
