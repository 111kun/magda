import { runPostgisQuery } from "../../../../libs/pglitePostgis";

type ResolvedRefPoint = {
    lon: number;
    lat: number;
    source: "dataset" | "nominatim";
};

function normalizeText(input: string): string {
    return (input || "").trim().toLowerCase();
}

async function resolveFromDataset(
    placeName: string
): Promise<ResolvedRefPoint | null> {
    const place = normalizeText(placeName);
    if (!place) {
        return null;
    }
    const candidateKeys = [
        "name",
        "Name",
        "NAME",
        "title",
        "street",
        "suburb",
        "address",
        "locality"
    ];
    const whereSql = candidateKeys
        .map(
            (key) =>
                `LOWER(COALESCE(properties->>'${key}','')) LIKE '%' || LOWER($1) || '%'`
        )
        .join(" OR ");
    const sql = `SELECT
  ST_X(ST_Centroid(geom)) AS lon,
  ST_Y(ST_Centroid(geom)) AS lat
FROM features
WHERE geom IS NOT NULL
  AND (${whereSql})
LIMIT 1`;
    const rows = await runPostgisQuery(sql, [place]);
    const row = rows?.[0];
    const lon = Number(row?.lon);
    const lat = Number(row?.lat);
    if (Number.isFinite(lon) && Number.isFinite(lat)) {
        return {
            lon,
            lat,
            source: "dataset"
        };
    }
    return null;
}

async function resolveFromNominatim(
    placeName: string,
    countrycodes?: string
): Promise<ResolvedRefPoint | null> {
    const params = new URLSearchParams({
        q: placeName,
        format: "jsonv2",
        limit: "1"
    });
    if (countrycodes?.trim()) {
        params.set("countrycodes", countrycodes.trim());
    }
    const res = await fetch(
        `https://nominatim.openstreetmap.org/search?${params.toString()}`,
        {
            headers: {
                Accept: "application/json"
            }
        }
    );
    if (!res.ok) {
        return null;
    }
    const data = (await res.json()) as Array<{ lon?: string; lat?: string }>;
    const hit = data?.[0];
    const lon = Number(hit?.lon);
    const lat = Number(hit?.lat);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
        return null;
    }
    return {
        lon,
        lat,
        source: "nominatim"
    };
}

export async function resolveReferencePoint(
    placeName: string,
    countrycodes?: string
): Promise<ResolvedRefPoint | null> {
    const inDataset = await resolveFromDataset(placeName);
    if (inDataset) {
        return inDataset;
    }
    return await resolveFromNominatim(placeName, countrycodes || "au");
}
