import React, {
    FunctionComponent,
    useCallback,
    useEffect,
    useState
} from "react";
import { useSelector, useDispatch } from "react-redux";
import {
    setIsOpen,
    setData,
    setEditorRef,
    setEditorContent
} from "../../actions/sqlConsoleActions";
import { StateType } from "reducers/reducer";
import { Small, Medium } from "../Common/Responsive";
import { useAsync } from "react-async-hook";
import Drawer from "rsuite/Drawer";
import ButtonToolbar from "rsuite/ButtonToolbar";
import Button from "rsuite/Button";
import Loader from "rsuite/Loader";
import Modal from "rsuite/Modal";
import Panel from "rsuite/Panel";
import RadioGroup from "rsuite/RadioGroup";
import Radio from "rsuite/Radio";
import Table from "rsuite/Table";
import Tooltip from "rsuite/Tooltip";
import Whisper from "rsuite/Whisper";
import reportError from "helpers/reportError";
import { runQuery } from "../../libs/sqlUtils";
import {
    formatImportSpatialResult,
    getPGlitePostgis,
    importSpatialFromDistribution,
    runPostgisQuery
} from "../../libs/pglitePostgis";
import downloadCsv from "../../libs/downloadCsv";
import { BsFillQuestionCircleFill } from "react-icons/bs";
import "./SQLConsole.scss";
import type { IAceEditor } from "react-ace/lib/types";
import reportWarn from "helpers/reportWarn";
import Popover from "rsuite/Popover";
import SimpleMathTextBox from "./SimpleMathTextBox";
import { config } from "../../config";
import type { ParsedDistribution } from "helpers/record";
import GeoJsonViewer from "../Chatbot/GeoJsonViewer";

const { Column, HeaderCell, Cell } = Table;
interface PropsType {
    [key: string]: any;
}

const maxDisplayRows: number = config.sqlConsoleMaxDisplayRows;

function looksLikeGeoSql(query: string): boolean {
    const text = (query || "").toLowerCase();
    return (
        /\bfeatures\b/.test(text) ||
        /\bgeom\b/.test(text) ||
        /\bst_/.test(text) ||
        /\bpostgis\b/.test(text) ||
        /\bgeosql\b/.test(text)
    );
}

/**
 * Convert any data array to an data array with single column with message
 *
 * @param {any[]} data
 * @return {*}  {any[]}
 */
function convertEmptyData(data: any[]): any[] {
    if (data?.length) {
        if (maxDisplayRows > 0 && data.length > maxDisplayRows) {
            return data.slice(0, maxDisplayRows);
        }
        return data;
    }
    return [{ "Query result:": "No data available for display..." }];
}

function convertCellData(data: any): any {
    if (data === null || data === undefined) {
        return "NULL";
    }
    if (typeof data === "boolean") {
        return data ? "true" : "false";
    }
    if (typeof data === "object") {
        return JSON.stringify(data);
    }
    if (typeof data === "string") {
        // replace all \r\n with \n
        return data.replace(/\r\n/g, "\n");
    }
    return data;
}

function stripOuterParens(input: string): string {
    const text = input.trim();
    return text.startsWith("(") && text.endsWith(")")
        ? text.slice(1, -1).trim()
        : text;
}

function splitTopLevel(input: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let start = 0;
    for (let i = 0; i < input.length; i++) {
        const char = input[i];
        if (char === "(") {
            depth++;
        } else if (char === ")") {
            depth--;
        } else if (char === "," && depth === 0) {
            parts.push(input.slice(start, i).trim());
            start = i + 1;
        }
    }
    parts.push(input.slice(start).trim());
    return parts.filter(Boolean);
}

function parseCoordPair(input: string): number[] {
    const nums = input
        .trim()
        .split(/\s+/)
        .map((item) => Number(item))
        .filter((item) => Number.isFinite(item));
    if (nums.length < 2) {
        throw new Error(`Invalid WKT coordinate: ${input}`);
    }
    return [nums[0], nums[1]];
}

function parseWktCoordinateList(input: string): number[][] {
    return input.split(",").map((item) => parseCoordPair(item));
}

function parseWktGeometry(rawWkt: string): any {
    const wkt = rawWkt.trim().replace(/^SRID=\d+;/i, "");
    const match = wkt.match(/^([a-z]+)(?:\s+(?:z|m|zm))?\s*\(([\s\S]*)\)$/i);
    if (!match) {
        throw new Error("Unsupported WKT geometry.");
    }
    const type = match[1].toUpperCase();
    const body = match[2].trim();
    switch (type) {
        case "POINT":
            return { type: "Point", coordinates: parseCoordPair(body) };
        case "LINESTRING":
            return {
                type: "LineString",
                coordinates: parseWktCoordinateList(body)
            };
        case "POLYGON":
            return {
                type: "Polygon",
                coordinates: splitTopLevel(body).map((ring) =>
                    parseWktCoordinateList(stripOuterParens(ring))
                )
            };
        case "MULTIPOINT":
            return {
                type: "MultiPoint",
                coordinates: splitTopLevel(body).map((point) =>
                    parseCoordPair(stripOuterParens(point))
                )
            };
        case "MULTILINESTRING":
            return {
                type: "MultiLineString",
                coordinates: splitTopLevel(body).map((line) =>
                    parseWktCoordinateList(stripOuterParens(line))
                )
            };
        case "MULTIPOLYGON":
            return {
                type: "MultiPolygon",
                coordinates: splitTopLevel(body).map((polygon) =>
                    splitTopLevel(stripOuterParens(polygon)).map((ring) =>
                        parseWktCoordinateList(stripOuterParens(ring))
                    )
                )
            };
        default:
            throw new Error(`Unsupported WKT geometry type: ${type}`);
    }
}

function tryParseJsonGeometry(value: any): any | null {
    const parsed =
        typeof value === "string" ? JSON.parse(value) : value && { ...value };
    if (
        parsed &&
        typeof parsed === "object" &&
        typeof parsed.type === "string" &&
        parsed.coordinates
    ) {
        return parsed;
    }
    return null;
}

function isBinaryGeomValue(value: any): boolean {
    if (!value) {
        return false;
    }
    if (value instanceof Uint8Array) {
        return true;
    }
    if (typeof value === "string") {
        return /^\\x[0-9a-f]+$/i.test(value.trim());
    }
    if (
        typeof value === "object" &&
        value?.type === "Buffer" &&
        Array.isArray(value?.data)
    ) {
        return true;
    }
    return false;
}

function hasBinaryGeomColumn(rows: Record<string, any>[]): boolean {
    return rows.some((row) => {
        const geomValue = row?.geom;
        return isBinaryGeomValue(geomValue);
    });
}

function uint8ArrayToHex(input: Uint8Array): string {
    return Array.from(input)
        .map((item) => item.toString(16).padStart(2, "0"))
        .join("");
}

function normalizeBinaryGeomForPostgis(value: any): any {
    if (value instanceof Uint8Array) {
        return `\\x${uint8ArrayToHex(value)}`;
    }
    if (typeof value === "object" && value?.type === "Buffer") {
        const arr = Array.isArray(value?.data) ? value.data : [];
        return `\\x${uint8ArrayToHex(new Uint8Array(arr))}`;
    }
    return value;
}

function rowToGeoJsonFeature(row: Record<string, any>): any | null {
    const entries = Object.entries(row);
    const geoJsonEntry = entries.find(([key]) =>
        /^(geom_?geojson|geojson|geometry|geom)$/i.test(key)
    );
    if (geoJsonEntry) {
        try {
            const geometry = tryParseJsonGeometry(geoJsonEntry[1]);
            if (geometry) {
                return {
                    type: "Feature",
                    geometry,
                    properties: row
                };
            }
        } catch {
            // Fall through to WKT parsing.
        }
    }

    const wktEntry = entries.find(
        ([key, value]) =>
            /^(geom_?wkt|wkt|geom)$/i.test(key) ||
            (typeof value === "string" &&
                /^\s*(SRID=\d+;)?\s*(POINT|LINESTRING|POLYGON|MULTIPOINT|MULTILINESTRING|MULTIPOLYGON)\s*(?:Z|M|ZM)?\s*\(/i.test(
                    value
                ))
    );
    if (!wktEntry || typeof wktEntry[1] !== "string") {
        return null;
    }
    return {
        type: "Feature",
        geometry: parseWktGeometry(wktEntry[1]),
        properties: row
    };
}

function buildGeoJsonFromRows(rows: Record<string, any>[]): any {
    const features = rows
        .map((row) => rowToGeoJsonFeature(row))
        .filter((feature) => !!feature);
    if (!features.length) {
        throw new Error(
            "No map-compatible geometry found. Include ST_AsText(geom) AS geom_wkt or ST_AsGeoJSON(geom) AS geom_geojson in the query result."
        );
    }
    return {
        type: "FeatureCollection",
        features
    };
}

const SQLConsole: FunctionComponent<PropsType> = (props) => {
    const {
        isOpen,
        data,
        editorRef: aceEditorCtlRef,
        editorContent
    } = useSelector((state: StateType) => state.sqlConsole);
    const currentDistribution = useSelector<
        StateType,
        ParsedDistribution | undefined
    >((state) => state.record.distribution);
    const dispatch = useDispatch();
    const setAceEditorCtlRef = useCallback(
        (ref) => {
            dispatch(setEditorRef(ref));
        },
        [dispatch]
    );
    const [size, setSize] = useState<string>("sm");
    const [engine, setEngine] = useState<"alasql" | "postgis">("alasql");
    const [isLoading, setIsLoading] = useState<boolean>(false);
    const [isImportingGeo, setIsImportingGeo] = useState<boolean>(false);
    const [isDownloadingCsv, setIsDownloadingCsv] = useState<boolean>(false);
    const [mapGeoJson, setMapGeoJson] = useState<any | null>(null);
    const aceEditorRef = aceEditorCtlRef?.editor;

    const onRunQuery = useCallback(
        async (query: string, params?: any[]) => {
            try {
                if (!query.trim()) {
                    throw new Error("the query supplied was empty!");
                }
                setIsLoading(true);
                if (
                    config.enablePglitePostgis &&
                    engine === "postgis" &&
                    looksLikeGeoSql(query)
                ) {
                    const pg = await getPGlitePostgis();
                    const countRes = await pg.query<{ count: number }>(
                        "SELECT COUNT(*)::int AS count FROM features"
                    );
                    const featureCount = Number(
                        countRes?.rows?.[0]?.count || 0
                    );
                    if (featureCount === 0) {
                        const currentUrl =
                            currentDistribution?.downloadURL ||
                            currentDistribution?.accessURL;
                        if (currentUrl) {
                            setIsImportingGeo(true);
                            try {
                                const inserted = await importSpatialFromDistribution(
                                    currentUrl,
                                    currentDistribution?.format,
                                    currentDistribution?.title
                                );
                                reportWarn(
                                    `Auto-imported current distribution: ${formatImportSpatialResult(
                                        inserted
                                    )}`,
                                    {
                                        duration: inserted.truncated
                                            ? 7000
                                            : 4000
                                    }
                                );
                            } finally {
                                setIsImportingGeo(false);
                            }
                        } else {
                            reportWarn(
                                "No spatial data loaded in PostGIS and current page has no distribution URL to auto-import."
                            );
                        }
                    }
                }
                const result =
                    config.enablePglitePostgis && engine === "postgis"
                        ? await runPostgisQuery(query, params)
                        : await runQuery(query, params);
                if (
                    Object.prototype.toString.call(result) === "[object Error]"
                ) {
                    throw result;
                }
                // result will comes with `columns` field for RECORDSET query
                // e.g. `SELECT RECORDSET * from source(0) limit 1`
                const data = result?.columns ? result.columns : result;
                if (maxDisplayRows > 0 && data?.length > maxDisplayRows) {
                    reportWarn(
                        `Query result is large than ${maxDisplayRows} rows. Only the first ${maxDisplayRows} rows will be displayed. However, you still can download the full result as a CSV file.`,
                        { duration: 5000 }
                    );
                }
                dispatch(setData(data));
            } catch (e) {
                const errorMsg = String(e);
                const msg =
                    errorMsg.indexOf("Failed to fetch") !== -1
                        ? "Failed to fetch the nominated data file due to network error"
                        : errorMsg;
                reportError(`Failed to execute SQL query: ${msg}`, {
                    duration: 5000
                });
            } finally {
                setIsLoading(false);
            }
        },
        [dispatch, engine, currentDistribution]
    );

    const onClose = useCallback(() => {
        const value = aceEditorRef?.getValue();
        dispatch(setEditorContent(value ? value : ""));
        dispatch(setIsOpen(false));
    }, [dispatch, aceEditorRef]);

    const onEditorLoad = useCallback(
        (editor: IAceEditor) => {
            if (editorContent) {
                editor.setValue(editorContent);
            }
        },
        [editorContent]
    );

    const onRunQueryButtonClick = useCallback(() => {
        const value = aceEditorRef?.getValue();
        onRunQuery(value ? value : "");
    }, [aceEditorRef, onRunQuery]);

    useEffect(() => {
        if (aceEditorRef) {
            aceEditorRef.commands.addCommand({
                name: "executeQuery",
                bindKey: {
                    win: "Shift-Enter",
                    mac: "Shift-Enter"
                },
                exec: onRunQueryButtonClick
            });
        }
    }, [aceEditorRef, onRunQueryButtonClick]);

    useEffect(() => {
        if (!config.enablePglitePostgis || !isOpen) {
            return;
        }
        const queryFromEditor =
            (aceEditorRef?.getValue ? aceEditorRef.getValue() : "") ||
            editorContent ||
            "";
        if (looksLikeGeoSql(queryFromEditor)) {
            setEngine("postgis");
        }
    }, [isOpen, editorContent, aceEditorRef]);

    const onDownloadButtonClick = useCallback(async () => {
        try {
            if (!data) {
                throw new Error("No data available to download!");
            }
            setIsDownloadingCsv(true);
            await downloadCsv(data, undefined, convertCellData);
        } catch (e) {
            reportError(`Error: ${e}`);
        } finally {
            setIsDownloadingCsv(false);
        }
    }, [data, setIsDownloadingCsv]);

    const onImportCurrentDistribution = useCallback(async () => {
        const currentUrl =
            currentDistribution?.downloadURL || currentDistribution?.accessURL;
        if (!currentUrl) {
            reportError(
                "Current page does not have a distribution URL to import."
            );
            return;
        }
        setIsImportingGeo(true);
        try {
            const inserted = await importSpatialFromDistribution(
                currentUrl,
                currentDistribution?.format,
                currentDistribution?.title
            );
            reportWarn(
                `Imported current distribution: ${formatImportSpatialResult(
                    inserted
                )}`,
                { duration: inserted.truncated ? 7000 : 4000 }
            );
        } catch (e) {
            reportError(`Failed to import current distribution: ${String(e)}`, {
                duration: 5000
            });
        } finally {
            setIsImportingGeo(false);
        }
    }, [currentDistribution]);

    const onViewResultOnMap = useCallback(async () => {
        try {
            if (!Array.isArray(data) || !data.length) {
                throw new Error("No query result to render on map.");
            }
            let rows = data as Record<string, any>[];

            if (
                config.enablePglitePostgis &&
                engine === "postgis" &&
                hasBinaryGeomColumn(rows)
            ) {
                rows = await Promise.all(
                    rows.map(async (row) => {
                        if (!isBinaryGeomValue(row?.geom)) {
                            return row;
                        }
                        try {
                            const geomInput = normalizeBinaryGeomForPostgis(
                                row.geom
                            );
                            const converted = await runPostgisQuery(
                                "SELECT ST_AsText($1::geometry) AS geom_wkt",
                                [geomInput]
                            );
                            const geomWkt = converted?.[0]?.geom_wkt;
                            return geomWkt
                                ? { ...row, geom_wkt: geomWkt }
                                : row;
                        } catch {
                            return row;
                        }
                    })
                );
            }

            setMapGeoJson(buildGeoJsonFromRows(rows));
        } catch (e) {
            reportError(`Failed to render query result on map: ${String(e)}`, {
                duration: 7000
            });
        }
    }, [data, engine]);

    const {
        result: AceEditor,
        loading: loadingAceEditor
    } = useAsync(async () => {
        try {
            const [{ default: AceEditor }] = await Promise.all([
                import(/* webpackChunkName:'react-ace' */ "react-ace"),
                import(
                    /* webpackChunkName:'react-ace' */ "ace-builds/src-noconflict/mode-sql"
                ),
                import(
                    /* webpackChunkName:'react-ace' */ "ace-builds/src-noconflict/theme-xcode"
                )
            ]);
            return AceEditor;
        } catch (e) {
            reportError(`Failed to load JSON editor: ${e}`);
            return;
        }
    }, []);

    const makeDrawerHeader = useCallback(
        (screeSize: "sm" | undefined) =>
            screeSize === "sm" ? (
                <Drawer.Header>
                    <Drawer.Title>SQL Console</Drawer.Title>
                </Drawer.Header>
            ) : (
                <Drawer.Header>
                    <Drawer.Title>SQL Console</Drawer.Title>
                    <Drawer.Actions>
                        <RadioGroup
                            inline
                            appearance="picker"
                            value={size}
                            onChange={setSize as any}
                        >
                            <span className="size-selector-heading">
                                Size:{" "}
                            </span>
                            <Radio value="sm">Small</Radio>
                            <Radio value="lg">Medium</Radio>
                            <Radio value="full">Full Screen</Radio>
                        </RadioGroup>
                    </Drawer.Actions>
                </Drawer.Header>
            ),
        [size, setSize]
    );

    const helpTooltip = (
        <Tooltip className="magda-sql-console-help-icon-tooltip">
            Please refer to{" "}
            <a
                target="_blank"
                rel="nofollow noopener noreferrer"
                href="https://github.com/magda-io/magda/blob/main/docs/docs/sql-console-user-guide.md"
            >
                this document
            </a>{" "}
            for SQL Console usage information.
        </Tooltip>
    );

    const makeDrawerBody = () => {
        const convertData = convertEmptyData(data);
        return (
            <Drawer.Body className="magda-sql-console-body">
                {isDownloadingCsv ? (
                    <Loader
                        backdrop
                        content="Exporting CSV data file..."
                        vertical
                    />
                ) : null}
                {isImportingGeo ? (
                    <Loader
                        backdrop
                        content="Importing current distribution into PostGIS..."
                        vertical
                    />
                ) : null}
                <div className="magda-sql-console-main-content-container">
                    <div className="query-row">
                        <Panel bordered className="query-panel">
                            {loadingAceEditor ? (
                                <Loader
                                    backdrop
                                    content="Loading SQL editor..."
                                    vertical
                                />
                            ) : AceEditor ? (
                                <div className="sql-editor-container">
                                    <AceEditor
                                        ref={setAceEditorCtlRef}
                                        onLoad={onEditorLoad}
                                        width="100%"
                                        name="magda-sql-console-editor"
                                        mode="sql"
                                        theme="xcode"
                                        showGutter={false}
                                        showPrintMargin={false}
                                        highlightActiveLine={false}
                                        fontSize={12}
                                        lineHeight={15}
                                        focus={true}
                                        setOptions={{
                                            enableMobileMenu: false,
                                            showLineNumbers: false,
                                            tabSize: 2
                                        }}
                                    />
                                </div>
                            ) : (
                                "Error: cannot load SQL Editor."
                            )}
                        </Panel>
                        <div className="button-tool-bar">
                            <div className="help-icon-container">
                                <Whisper
                                    placement={"auto"}
                                    controlId="magda-sql-console-help-tooltip"
                                    trigger="hover"
                                    speaker={helpTooltip}
                                    delayClose={2000}
                                >
                                    <div className="help-icon">
                                        <BsFillQuestionCircleFill className="help-icon" />
                                    </div>
                                </Whisper>
                            </div>
                            <ButtonToolbar>
                                {config.enablePglitePostgis ? (
                                    <RadioGroup
                                        inline
                                        appearance="picker"
                                        value={engine}
                                        onChange={setEngine as any}
                                    >
                                        <Radio value="alasql">AlaSQL</Radio>
                                        <Radio value="postgis">PostGIS</Radio>
                                    </RadioGroup>
                                ) : null}
                                {config.enablePglitePostgis ? (
                                    <Button
                                        appearance="default"
                                        disabled={isImportingGeo}
                                        onClick={onImportCurrentDistribution}
                                    >
                                        Load Current Distribution
                                    </Button>
                                ) : null}
                                <Button
                                    className="run-query-button"
                                    appearance="primary"
                                    onClick={onRunQueryButtonClick}
                                >
                                    Run Query
                                </Button>
                                <Button
                                    className="download-result-button"
                                    appearance="primary"
                                    disabled={!data?.length}
                                    onClick={onDownloadButtonClick}
                                >
                                    Download Result
                                </Button>
                                <Button
                                    appearance="primary"
                                    disabled={!data?.length}
                                    onClick={onViewResultOnMap}
                                >
                                    View on Map
                                </Button>
                            </ButtonToolbar>
                        </div>
                    </div>
                    <Panel className="data-row" bordered>
                        {isLoading ? (
                            <Loader
                                backdrop
                                content="Executing query..."
                                vertical
                            />
                        ) : (
                            <Table
                                virtualized={true}
                                fillHeight={true}
                                hover={true}
                                showHeader={true}
                                cellBordered={true}
                                headerHeight={30}
                                rowHeight={30}
                                data={convertData}
                            >
                                {Object.keys(convertData[0]).map((key, idx) => (
                                    <Column
                                        width={130}
                                        key={idx}
                                        resizable
                                        flexGrow={1}
                                    >
                                        <HeaderCell style={{ padding: 4 }}>
                                            {key}
                                        </HeaderCell>
                                        <Cell
                                            dataKey={key}
                                            style={{ padding: 4 }}
                                        >
                                            {(rowData) => {
                                                const convertedContent = convertCellData(
                                                    rowData[key]
                                                );
                                                if (
                                                    typeof convertedContent ===
                                                        "string" &&
                                                    convertedContent.length < 25
                                                ) {
                                                    return convertedContent;
                                                } else {
                                                    return (
                                                        <Whisper
                                                            trigger="click"
                                                            placement="auto"
                                                            speaker={
                                                                <Popover>
                                                                    <SimpleMathTextBox>
                                                                        {
                                                                            convertedContent
                                                                        }
                                                                    </SimpleMathTextBox>
                                                                </Popover>
                                                            }
                                                        >
                                                            <div className="magda-sql-console-cell-content-with-tooltip">
                                                                {
                                                                    convertedContent
                                                                }
                                                            </div>
                                                        </Whisper>
                                                    );
                                                }
                                            }}
                                        </Cell>
                                    </Column>
                                ))}
                            </Table>
                        )}
                    </Panel>
                </div>
            </Drawer.Body>
        );
    };

    return (
        <div className="magda-sql-console-main-container">
            <Small>
                <Drawer
                    className="magda-sql-console-drawer"
                    placement={"bottom"}
                    open={isOpen}
                    onClose={onClose}
                    backdrop={false}
                    size={"full" as any}
                >
                    {makeDrawerHeader("sm")}
                    {makeDrawerBody()}
                </Drawer>
            </Small>
            <Medium>
                <Drawer
                    className="magda-sql-console-drawer"
                    placement={"bottom"}
                    open={isOpen}
                    onClose={onClose}
                    backdrop={true}
                    size={size as any}
                >
                    {makeDrawerHeader(undefined)}
                    {makeDrawerBody()}
                </Drawer>
            </Medium>
            <Modal
                size="lg"
                overflow={false}
                open={!!mapGeoJson}
                onClose={() => setMapGeoJson(null)}
            >
                <Modal.Header>
                    <Modal.Title>SQL Result Map</Modal.Title>
                </Modal.Header>
                <Modal.Body>
                    {mapGeoJson ? (
                        <GeoJsonViewer
                            geoJson={mapGeoJson}
                            isJsonString={false}
                        />
                    ) : null}
                </Modal.Body>
            </Modal>
        </div>
    );
};

export default SQLConsole;
