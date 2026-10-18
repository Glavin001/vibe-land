import type {VehicleConfiguration} from './configuration.mjs';
export interface GarageBuild {id:string; name:string; description:string; configuration:VehicleConfiguration}
export const garageBuilds:GarageBuild[];
