import React, { FunctionComponent, useLayoutEffect, useMemo } from "react";
import { Message } from "rsuite";
import stripJsonComments from "strip-json-comments";
import L from "leaflet";
import { Map, TileLayer, GeoJSON } from "react-leaflet";
import "leaflet/dist/leaflet.css";
import "./GeoJsonViewer.scss";

/** Webpack bundles Leaflet without `leaflet.js` script path; 0.7 needs this set. */
const LEAFLET_DEFAULT_ICON_IMAGE_PATH =
    "https://unpkg.com/leaflet@0.7.7/dist/images";

/** Stroke / ring colour for query-result style (hollow red circles, red outlines). */
const RESULT_LINE_COLOR = "#c62828";
const RESULT_LINE_COLOR_HI = "#b71c1c";

const POINT_STYLE_DEFAULT: L.PathOptions = {
    radius: 6,
    color: RESULT_LINE_COLOR,
    weight: 2,
    fillColor: "#ffffff",
    fillOpacity: 0.15,
    opacity: 1
};

const POINT_STYLE_HIGHLIGHT: L.PathOptions = {
    radius: 9,
    color: RESULT_LINE_COLOR_HI,
    weight: 3,
    fillColor: "#ffcdd2",
    fillOpacity: 0.55,
    opacity: 1
};

const LINE_STYLE_DEFAULT: L.PathOptions = {
    color: RESULT_LINE_COLOR,
    weight: 2,
    opacity: 1,
    fillOpacity: 0
};

const LINE_STYLE_HIGHLIGHT: L.PathOptions = {
    color: RESULT_LINE_COLOR_HI,
    weight: 4,
    opacity: 1,
    fillOpacity: 0
};

const POLYGON_STYLE_DEFAULT: L.PathOptions = {
    color: RESULT_LINE_COLOR,
    weight: 2,
    opacity: 1,
    fillColor: "#ffcdd2",
    fillOpacity: 0.22
};

const POLYGON_STYLE_HIGHLIGHT: L.PathOptions = {
    color: RESULT_LINE_COLOR_HI,
    weight: 3,
    opacity: 1,
    fillColor: "#ffab91",
    fillOpacity: 0.45
};

function getHoverStylePair(
    feature: any
): { defaultStyle: L.PathOptions; highlightStyle: L.PathOptions } {
    const t = feature?.geometry?.type as string | undefined;
    if (t === "Point" || t === "MultiPoint") {
        return {
            defaultStyle: { ...POINT_STYLE_DEFAULT },
            highlightStyle: { ...POINT_STYLE_HIGHLIGHT }
        };
    }
    if (t === "LineString" || t === "MultiLineString") {
        return {
            defaultStyle: { ...LINE_STYLE_DEFAULT },
            highlightStyle: { ...LINE_STYLE_HIGHLIGHT }
        };
    }
    return {
        defaultStyle: { ...POLYGON_STYLE_DEFAULT },
        highlightStyle: { ...POLYGON_STYLE_HIGHLIGHT }
    };
}

function bindPathHoverHighlight(
    layer: L.Layer,
    defaultStyle: L.PathOptions,
    highlightStyle: L.PathOptions
): void {
    const bindOne = (ly: L.Layer) => {
        const path = ly as L.Path;
        if (typeof path.setStyle !== "function") {
            return;
        }
        path.on("mouseover", () => {
            path.setStyle({ ...highlightStyle });
        });
        path.on("mouseout", () => {
            path.setStyle({ ...defaultStyle });
        });
    };

    const group = layer as L.LayerGroup;
    if (group && typeof group.eachLayer === "function") {
        group.eachLayer(bindOne);
    } else {
        bindOne(layer);
    }
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function sanitizePropertiesForJson(props: unknown): Record<string, unknown> {
    if (!props || typeof props !== "object" || Array.isArray(props)) {
        return {};
    }
    const out: Record<string, unknown> = {};
    const raw = props as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
        if (key.startsWith("__")) {
            continue;
        }
        const v = raw[key];
        if (v === undefined) {
            continue;
        }
        if (v !== null && typeof v === "object") {
            if (
                typeof ArrayBuffer !== "undefined" &&
                v instanceof ArrayBuffer
            ) {
                out[key] = `(binary, ${v.byteLength} bytes)`;
                continue;
            }
            if (ArrayBuffer.isView(v)) {
                const view = v as ArrayBufferView;
                out[key] = `(binary view, ${view.byteLength} bytes)`;
                continue;
            }
        }
        out[key] = v as unknown;
    }
    return out;
}

function formatFeaturePropertiesPopupHtml(feature: any): string {
    const props = sanitizePropertiesForJson(feature?.properties);
    let json = "{}";
    try {
        json = JSON.stringify(
            props,
            (_k, v) => (typeof v === "bigint" ? v.toString() : v),
            2
        );
    } catch {
        json = JSON.stringify({ error: "Could not serialize properties" });
    }
    const safeJson = escapeHtml(json);
    return (
        `<div class="magda-geojson-popup">` +
        `<div class="magda-geojson-popup-title">Feature properties</div>` +
        `<pre class="magda-geojson-popup-json">${safeJson}</pre>` +
        `</div>`
    );
}

function geoJsonLayerOptions(): {
    pointToLayer: (feature: any, latlng: L.LatLng) => L.CircleMarker;
    style: (feature: any) => L.PathOptions;
    onEachFeature: (feature: any, layer: L.Layer) => void;
} {
    return {
        pointToLayer: (_feature, latlng) =>
            L.circleMarker(latlng, { ...POINT_STYLE_DEFAULT }),
        style(feature) {
            const t = feature?.geometry?.type as string | undefined;
            if (t === "LineString" || t === "MultiLineString") {
                return { ...LINE_STYLE_DEFAULT };
            }
            return { ...POLYGON_STYLE_DEFAULT };
        },
        onEachFeature(feature, layer) {
            const { defaultStyle, highlightStyle } = getHoverStylePair(feature);
            bindPathHoverHighlight(layer, defaultStyle, highlightStyle);

            const html = formatFeaturePropertiesPopupHtml(feature);
            const withPopup = layer as L.Layer & {
                bindPopup: (c: string, o?: object) => void;
            };
            withPopup.bindPopup(html, {
                maxWidth: 440,
                closeButton: true,
                autoPan: true
            });
        }
    };
}

function useParsedGeoJson(
    geoJson: any,
    isJsonString: boolean | undefined
): { data: any; error: string | null } {
    return useMemo(() => {
        if (isJsonString === false) {
            return { data: geoJson, error: null };
        }
        const geoJsonContent = String(geoJson ?? "").trim();
        if (!geoJsonContent) {
            return { data: null, error: "Empty GeoJSON input." };
        }
        try {
            return { data: JSON.parse(geoJsonContent), error: null };
        } catch {
            try {
                return {
                    data: JSON.parse(stripJsonComments(geoJsonContent)),
                    error: null
                };
            } catch (e) {
                return { data: null, error: String(e) };
            }
        }
    }, [geoJson, isJsonString]);
}

const LeafletGeoJsonViewer: FunctionComponent<{ data: any }> = ({ data }) => {
    useLayoutEffect(() => {
        L.Icon.Default.imagePath = LEAFLET_DEFAULT_ICON_IMAGE_PATH;
    }, []);

    const geoJsonOpts = useMemo(() => geoJsonLayerOptions(), []);

    const bounds = useMemo(() => {
        try {
            const gj = L.geoJSON(data, geoJsonOpts);
            const b = gj.getBounds();
            return b.isValid() ? b : null;
        } catch {
            return null;
        }
    }, [data, geoJsonOpts]);

    const mapProps = bounds
        ? ({
              bounds,
              boundsOptions: { padding: [24, 24] }
          } as const)
        : ({
              center: [-25.27, 133.78] as L.LatLngTuple,
              zoom: 4
          } as const);

    return (
        <div className="geo-json-viewer-leaflet">
            <Map
                {...mapProps}
                style={{ width: "100%", height: "500px" }}
                className="geo-json-viewer-leaflet-map"
            >
                <TileLayer
                    url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
                    attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>'
                />
                <GeoJSON data={data} {...geoJsonOpts} />
            </Map>
        </div>
    );
};

interface GeoJsonViewerProps {
    geoJson: any;
    // if not specified or set to true, it will be assumed that geoJson is a JSON string
    // When set to false, geoJson will be treated as an object
    isJsonString?: boolean;
}

/** Renders GeoJSON on an embedded Leaflet map (OSM tiles). */
const GeoJsonViewer: FunctionComponent<GeoJsonViewerProps> = ({
    geoJson,
    isJsonString
}) => {
    const { data: parsedData, error: parseError } = useParsedGeoJson(
        geoJson,
        isJsonString
    );

    if (parseError) {
        return (
            <Message showIcon type="error">
                {`Failed to parse GeoJSON: ${parseError}`}
            </Message>
        );
    }

    if (!parsedData) {
        return null;
    }

    return <LeafletGeoJsonViewer data={parsedData} />;
};

export default GeoJsonViewer;
