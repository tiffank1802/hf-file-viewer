#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const devVars = resolve(process.cwd(), '.dev.vars');

if (existsSync(devVars)) {
  const content = readFileSync(devVars, 'utf8');
  const hasApsClientId = content.includes('APS_CLIENT_ID="')
    && !content.includes('APS_CLIENT_ID="your_aps_client_id"');
  const hasApsSecret = content.includes('APS_CLIENT_SECRET="')
    && !content.includes('APS_CLIENT_SECRET="your_aps_client_secret"');

  if (!(hasApsClientId && hasApsSecret)) {
    console.warn(
      '\n⚠️  Le fichier .dev.vars existe mais les valeurs Autodesk APS du 3D\n' +
      '   ne sont pas encore renseignées (valeurs d’exemple).\n' +
      '   Les fichiers 3D afficheront un message de téléchargement.\n' +
      '   Remplacez APS_CLIENT_ID et APS_CLIENT_SECRET dans .dev.vars.\n',
    );
  }
  process.exit(0);
}

console.warn(
  '\n⚠️  Aucun fichier .dev.vars trouvé.\n' +
  '   Le Worker local ne pourra pas accéder à Autodesk pour les fichiers 3D.\n' +
  '   Créez-le depuis le modèle, qui ne contient aucune valeur réelle :\n\n' +
  '     cp .dev.vars.example .dev.vars\n' +
  '     # puis renseignez APS_CLIENT_ID et APS_CLIENT_SECRET\n\n' +
  '   Ce fichier est ignoré par Git, il ne doit jamais être versionné.\n',
);
process.exit(0);
