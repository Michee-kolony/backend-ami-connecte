// Sous-fenêtre 7 — Analyse des couvertures sanitaires : réalisations observées dans les modules
// AMI (CPN, accouchement, nouveau-né, vaccination) ÷ populations cibles validées (sous-fenêtre 3),
// proratisées à la durée de la période. Numérateur et dénominateur toujours affichés ; absence de
// dénominateur → « non calculable » ; couverture > 100 % signalée pour vérification, jamais
// ramenée à 100 % ; résultats observés et estimés distingués.
const EntiteGeographique = require('../../models/EntiteGeographique');
const epi = require('../../config/epidemiologie');
const moteur = require('../../config/moteurEpidemiologie');
const { texte } = require('../saisie');
const c = require('./commun');
const { cibleValidee } = require('./cibles');
const { fichesIndicateurs } = require('./parametres');

const codeRealisation = (f) => (f.realisation === 'CPN4' ? 'CPN_REQUIS' : f.realisation);

/**
 * Couvertures d'une entité sur une période. `etablissementIds` : périmètre des réalisations.
 * Renvoie indicateurs, abandons, zéro dose, continuité des soins et évolution mensuelle.
 */
async function couvertures(req, { entiteCode, du, au, mensuel = true }) {
  const e = await c.entite(entiteCode);
  const annee = Number(du.slice(0, 4));
  const fiches = await fichesIndicateurs();
  const contactsCpnRequis = Number(fiches.find((f) => f.intervention === 'CPN4')?.parametres?.contactsRequis) || 4;
  const [{ etablissementIds, restreint }, calcul] = await Promise.all([c.perimetre(req, e.code), cibleValidee(e.code, annee)]);
  const r = await moteur.realisations({ etablissementIds, du, au, contactsCpnRequis });
  const fraction = moteur.fractionAnnee(du, au);
  const denominateur = (cible) => {
    const annuel = calcul?.cible(cible);
    return annuel == null ? null : Math.round(annuel * fraction * 100) / 100;
  };
  const indicateurs = fiches.map((f) => {
    const num = r.total[codeRealisation(f)] ?? null;
    const den = denominateur(f.cible);
    const res = moteur.ratio(num, den);
    return {
      code: f.code, nom: f.nom, intervention: f.intervention, cible: f.cible, libelleCible: epi.CIBLES[f.cible],
      numerateur: num, denominateur: den, valeur: res.valeur,
      raison: res.raison,
      nonCalculable: res.valeur == null,
      depassement: res.valeur != null && res.valeur > 100,
      sousSeuil: res.valeur != null && f.seuilReference != null && res.valeur < f.seuilReference,
      seuilReference: f.seuilReference,
      formule: `${f.nom} = ${f.numerateur.replace(/\.$/, '')} ÷ ${epi.CIBLES[f.cible]} (${calcul ? `calcul ${calcul.numero} v${calcul.version}` : 'calcul validé absent'}${fraction < 1 ? `, × ${Math.round(fraction * 12)}/12 pour la période` : ''}) × 100`,
      ficheValidee: f.statut === 'Validé', ficheVersion: f.version,
      natureNumerateur: 'Observée (modules AMI)', natureDenominateur: calcul ? `Estimée (${calcul.population.nature ?? 'population de référence'})` : null,
    };
  });
  if (!calcul) for (const i of indicateurs) i.raison = 'Non calculable : aucune population cible validée pour ce territoire et cette année (sous-fenêtre 3).';
  const t = r.total;
  const abandon = (a, b, code, libelle, formule) => ({ code, libelle, numerateur: a == null || b == null ? null : a - b, denominateur: a, ...moteur.ratio(a == null || b == null ? null : a - b, a), formule });
  const result = {
    entite: { code: e.code, nom: e.nom, niveau: e.niveau }, du, au, annee, restreint, etablissements: etablissementIds.length,
    calcul: calcul ? { id: calcul.id, numero: calcul.numero, version: calcul.version, resultats: calcul.resultats } : null,
    contactsCpnRequis,
    indicateurs,
    abandons: [
      abandon(t.PENTA1, t.PENTA3, 'ABANDON-PENTA', 'Taux d’abandon Penta1-Penta3', '(Penta1 − Penta3) ÷ Penta1 × 100'),
      abandon(t.CPN1, t.CPN_REQUIS, 'ABANDON-CPN', `Taux d’abandon CPN1-CPN${contactsCpnRequis}`,
        `(CPN1 − CPN${contactsCpnRequis}) ÷ CPN1 × 100 — approche transversale sur la période ; un rendez-vous manqué n’est pas un abandon définitif (fiche de cohorte à valider)`),
    ],
    zeroDose: {
      enfantsSuivis: r.enfantsSuivis, zeroDose: r.zeroDose, sousVaccines: r.sousVaccines,
      proportionZeroDose: moteur.ratio(r.zeroDose, r.enfantsSuivis).valeur, proportionSousVaccines: moteur.ratio(r.sousVaccines, r.enfantsSuivis).valeur,
      definition: 'Zéro dose : enfant suivi dont le Penta1 est échu (en retard ou hors délai) et non reçu à la fin de la période ; sous-vacciné : au moins un vaccin échu non reçu.',
    },
    continuite: [
      { code: 'CONT-CPN-ACC', libelle: 'CPN1 → accouchement assisté', numerateur: t.ACC, denominateur: t.CPN1, ...moteur.ratio(t.ACC, t.CPN1), formule: 'Accouchements assistés ÷ CPN1 de la période × 100 (indicatif, transversal)' },
      { code: 'CONT-ACC-CPON', libelle: 'Naissance vivante → consultation postnatale (J7)', numerateur: t.CPON, denominateur: r.naissancesVivantes, ...moteur.ratio(t.CPON, r.naissancesVivantes), formule: 'Nouveau-nés vus dans les 7 jours ÷ naissances vivantes × 100' },
      { code: 'CONT-NAIS-BCG', libelle: 'Naissance vivante → BCG', numerateur: t.BCG, denominateur: r.naissancesVivantes, ...moteur.ratio(t.BCG, r.naissancesVivantes), formule: 'BCG administrés ÷ naissances vivantes × 100 (indicatif)' },
    ],
    realisations: { ...t, naissancesVivantes: r.naissancesVivantes, mortNes: r.mortNes },
  };
  if (mensuel) {
    result.evolution = r.mois.map((mois) => ({
      mois,
      ...Object.fromEntries(fiches.map((f) => {
        const annuel = calcul?.cible(f.cible);
        return [f.code, { realisations: r.parMois[mois][codeRealisation(f)], couverture: annuel == null ? null : moteur.ratio(r.parMois[mois][codeRealisation(f)], annuel / 12).valeur }];
      })),
    }));
  }
  return result;
}
exports.calculCouvertures = couvertures;

exports.couvertures = async (req, res) => {
  const p = c.periode(req.query);
  const entiteCode = req.query.entite ? texte(req.query.entite, 80).toUpperCase() : await c.entiteParDefaut(req);
  res.json(await couvertures(req, { entiteCode, du: p.du, au: p.au }));
};

/**
 * Comparaison des couvertures entre structures (§7.5, tableau 2) : chaque formation sanitaire (ou
 * entité enfant) du territoire, avec ses propres cibles validées.
 */
exports.structures = async (req, res) => {
  const p = c.periode(req.query);
  const code = req.query.entite ? texte(req.query.entite, 80).toUpperCase() : await c.entiteParDefaut(req);
  const niveau = req.query.niveau === 'enfants' ? null : 'Formation sanitaire';
  const entites = niveau
    ? await EntiteGeographique.find({ chemin: code, niveau, actif: true }).sort({ nom: 1 }).lean()
    : await EntiteGeographique.find({ parentCode: code, actif: true }).sort({ nom: 1 }).lean();
  const lignes = [];
  for (const e of entites.slice(0, 200)) {
    const x = await couvertures(req, { entiteCode: e.code, du: p.du, au: p.au, mensuel: false });
    if (x.restreint && !x.etablissements) continue; // hors du périmètre autorisé
    const v = (codeInd) => x.indicateurs.find((i) => i.code === codeInd) ?? null;
    lignes.push({
      code: e.code, nom: e.nom, niveau: e.niveau, calcul: !!x.calcul,
      indicateurs: Object.fromEntries(x.indicateurs.map((i) => [i.code, { valeur: i.valeur, numerateur: i.numerateur, denominateur: i.denominateur, depassement: i.depassement }])),
      abandonPenta: x.abandons[0].valeur, abandonCpn: x.abandons[1].valeur, zeroDose: x.zeroDose.zeroDose,
      cpn1: v('COUV-CPN1')?.valeur ?? null, penta1: v('COUV-PENTA1')?.valeur ?? null, penta3: v('COUV-PENTA3')?.valeur ?? null,
    });
  }
  res.json({ periode: p, entiteCode: code, lignes });
};
