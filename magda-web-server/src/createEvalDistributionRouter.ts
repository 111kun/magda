import express from "express";
import fs from "fs";
import path from "path";

type EvalDistributionManifestItem = {
    sourceUrl?: string;
    distributionId?: string;
    localFile: string;
};

type EvalDistributionManifest = {
    mappings?: EvalDistributionManifestItem[];
};

type Options = {
    apiPath: string;
    manifestPath: string;
};

function loadManifest(manifestPath: string): EvalDistributionManifest {
    if (!manifestPath.trim()) {
        return { mappings: [] };
    }
    const content = fs.readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(content) as EvalDistributionManifest;
    if (!Array.isArray(parsed?.mappings)) {
        return { mappings: [] };
    }
    return parsed;
}

function toAbsolutePath(filePath: string, manifestPath: string): string {
    if (path.isAbsolute(filePath)) {
        return filePath;
    }
    return path.resolve(path.dirname(manifestPath), filePath);
}

export default function createEvalDistributionRouter(options: Options) {
    const router = express.Router();
    const apiPath = options.apiPath.trim();
    const manifestPath = options.manifestPath.trim();

    if (!apiPath) {
        throw new Error(
            "createEvalDistributionRouter requires a non-empty apiPath."
        );
    }

    router.get(apiPath, (req, res) => {
        try {
            if (!manifestPath) {
                res.status(500).json({
                    error:
                        "Eval distribution manifest path is not configured on server."
                });
                return;
            }
            const sourceUrl =
                typeof req.query.sourceUrl === "string"
                    ? req.query.sourceUrl
                    : "";
            const distributionId =
                typeof req.query.distributionId === "string"
                    ? req.query.distributionId
                    : "";
            if (!sourceUrl && !distributionId) {
                res.status(400).json({
                    error:
                        "Either sourceUrl or distributionId query param is required."
                });
                return;
            }

            const manifest = loadManifest(manifestPath);
            const matched = (manifest.mappings || []).find((item) => {
                if (
                    distributionId &&
                    item.distributionId &&
                    item.distributionId === distributionId
                ) {
                    return true;
                }
                if (
                    sourceUrl &&
                    item.sourceUrl &&
                    item.sourceUrl === sourceUrl
                ) {
                    return true;
                }
                return false;
            });

            if (!matched?.localFile) {
                res.status(404).json({
                    error:
                        "No eval-local distribution mapping found for requested source."
                });
                return;
            }

            const absPath = toAbsolutePath(matched.localFile, manifestPath);
            if (!fs.existsSync(absPath)) {
                res.status(404).json({
                    error: `Mapped local file does not exist: ${absPath}`
                });
                return;
            }

            res.sendFile(absPath);
        } catch (e) {
            const message = e instanceof Error ? e.message : String(e);
            res.status(500).json({
                error: `Failed to resolve eval-local distribution: ${message}`
            });
        }
    });

    return router;
}
