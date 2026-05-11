declare module "@tmcw/togeojson" {
    export function kml(doc: Document): any;
}

declare module "shpjs" {
    const shp: (input: ArrayBuffer) => Promise<any>;
    export default shp;
}

declare module "@electric-sql/pglite" {
    export class PGlite {
        static create(options?: any): Promise<any>;
        exec(sql: string): Promise<any[]>;
        query<T = any>(sql: string, params?: any[]): Promise<{ rows?: T[] }>;
    }
}

declare module "@electric-sql/pglite-postgis" {
    export function postgis(): any;
}
