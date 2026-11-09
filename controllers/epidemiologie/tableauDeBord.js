// Vue générale — tableau de bord épidémiologique : chiffres clés des dix sous-fenêtres pour le
// territoire choisi (par défaut celui de la structure de connexion) et état d'avancement du socle
// (population, coefficients, cibles, plans), dans l'ordre des étapes recommandées.
const PopulationReference = require('../../models/PopulationReference');
const CoefficientDemographique = require('../../models/CoefficientDemographique');
const PlanCible = require('../../models/PlanCible');
const AlerteEpi = require('../../models/AlerteEpi');
const Deces = require('../../models/Deces');
const epi = require('../../config/epidemiologie');
const moteur = require('../../config/moteurEpidemiologie');
const { texte } = require('../saisie');
const c = require('./commun');
const { initialiser } = require('./referentiel');
const { cibleValidee } = require('./cibles');
const { calculCouvertures } = require('./couvertures');
const { calculTableau } = require('./surveillance');

exports.tableauDeBord = async (req, res) => {
  await initialiser();
  const code = req.query.entite ? texte(req.query.entite, 80).toUpperCase() : await c.entiteParDefaut(req);
  const e = await c.entite(code);
  const annee = c.annee(req.query.annee);
  const auj = moteur.jourKinshasa(new Date());
  const au = String(annee) === auj.slice(0, 4) ? auj : `${annee}-12-31`;
  const codes = (await c.descendants(code)).map((x) => x.code);
  const [pop, calcul, coefsValides, plans, couv, surv, alertes, decesMat, decesNeo] = await Promise.all([
    PopulationReference.findOne({ entiteCode: code, annee, statut: { $ne: 'Archivé' } }).sort({ version: -1 }),
    cibleValidee(code, annee),
    CoefficientDemographique.countDocuments({ statut: 'Validé' }),
    PlanCible.find({ entiteCode: code, annee, statut: { $nin: ['Archivé', 'Rejeté'] } }).select('intervention statut').lean(),
    calculCouvertures(req, { entiteCode: code, du: `${annee}-01-01`, au, mensuel: true }),
    calculTableau({ dans: code, du: `${annee}-01-01`, au }),
    AlerteEpi.find({ entiteCode: { $in: [...codes, null] }, statut: { $in: epi.STATUTS_ALERTE_OUVERTS } }).select('priorite echeance').lean(),
    Deces.countDocuments({ entiteCode: { $in: codes }, maternel: 'Oui', statut: 'Validé', dateDeces: { $gte: `${annee}-01-01`, $lte: au } }),
    Deces.countDocuments({ entiteCode: { $in: codes }, neonatal: 'Oui', statut: 'Validé', dateDeces: { $gte: `${annee}-01-01`, $lte: au } }),
  ]);
  let enAttente = 0;
  for (const { Modele } of Object.values(c.REGISTRE)) enAttente += await Modele.countDocuments({ statut: 'Soumis' });
  const cle = (codeInd) => couv.indicateurs.find((i) => i.code === codeInd) ?? null;
  const etape = (ok, libelle, detail, lien) => ({ ok, libelle, detail, lien });
  res.json({
    entite: { code: e.code, nom: e.nom, niveau: e.niveau }, annee, au,
    population: pop ? { totale: pop.totale, hommes: pop.hommes, femmes: pop.femmes, statut: pop.statut, version: pop.version, nature: pop.nature } : null,
    cibles: calcul ? calcul.resultats.map((r) => ({ cible: r.cible, libelle: r.libelle, valeur: r.valeur })) : [],
    couvertures: ['COUV-CPN1', 'COUV-CPN4', 'COUV-ACC', 'COUV-PENTA1', 'COUV-PENTA3', 'COUV-VAR1'].map(cle).filter(Boolean)
      .map((i) => ({ code: i.code, nom: i.nom, valeur: i.valeur, numerateur: i.numerateur, denominateur: i.denominateur, depassement: i.depassement, raison: i.raison })),
    abandons: couv.abandons.map((a) => ({ code: a.code, libelle: a.libelle, valeur: a.valeur })),
    zeroDose: couv.zeroDose,
    evolution: couv.evolution?.map((m) => ({ mois: m.mois, CPN1: m['COUV-CPN1']?.realisations ?? 0, PENTA3: m['COUV-PENTA3']?.realisations ?? 0, ACC: m['COUV-ACC']?.realisations ?? 0 })) ?? [],
    surveillance: { ...surv.resume, maladies: surv.maladies.slice(0, 5), courbe: surv.courbe },
    mortalite: { maternels: decesMat, neonatals: decesNeo },
    alertes: {
      ouvertes: alertes.length, critiques: alertes.filter((a) => a.priorite === 'Critique').length,
      enRetard: alertes.filter((a) => a.echeance && a.echeance < auj).length,
      parPriorite: epi.PRIORITES.map((p) => ({ libelle: p, n: alertes.filter((a) => a.priorite === p).length })),
    },
    validation: { enAttente },
    restreint: couv.restreint,
    etapes: [
      etape(pop?.statut === 'Validé', 'Population de référence validée', pop ? `${pop.totale.toLocaleString('fr-FR')} hab. — ${pop.statut}` : 'Non renseignée', 'demographie'),
      etape(coefsValides >= Object.keys(epi.CIBLES).length, 'Coefficients validés', `${coefsValides} coefficient(s) validé(s)`, 'parametres'),
      etape(!!calcul, 'Populations cibles calculées et validées', calcul ? `${calcul.numero} v${calcul.version}` : 'Aucun calcul validé', 'cibles'),
      etape(plans.some((p) => p.statut === 'Validé'), 'Objectifs planifiés', `${plans.length} plan(s), ${plans.filter((p) => p.statut === 'Validé').length} validé(s)`, 'planification'),
    ],
  });
};
