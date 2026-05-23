import type { ExecutableAst } from "./executableAst";
import { renderWhereClause } from "./executableAst";

export function renderSqlFromAst(ast: ExecutableAst): string | null {
    const where = renderWhereClause(ast);

    if (ast.queryType === "MEASUREMENT" && ast.measurement) {
        return `SELECT ${ast.measurement.expression} AS ${ast.measurement.alias} FROM features WHERE ${where}`;
    }

    if (ast.queryType === "FILTER_COUNT" && ast.aggregate) {
        return `SELECT ${ast.aggregate.expression} AS ${ast.aggregate.alias} FROM features WHERE ${where}`;
    }

    if (
        ast.queryType === "AGGREGATE_GROUP_BY" &&
        ast.grouping.length &&
        ast.aggregate
    ) {
        const selectList = [
            ...ast.selectColumns.map((c) => `${c.expression} AS ${c.alias}`),
            `${ast.aggregate.expression} AS ${ast.aggregate.alias}`
        ].join(", ");
        const groupBy = ast.grouping.join(", ");
        const orderBy = ast.orderBy.length
            ? ` ORDER BY ${ast.orderBy
                  .map((o) => `${o.expression} ${o.direction}`)
                  .join(", ")}`
            : "";
        const limit = ast.limit ? ` LIMIT ${ast.limit}` : "";
        return `SELECT ${selectList} FROM features WHERE ${where} GROUP BY ${groupBy}${orderBy}${limit}`;
    }

    if (ast.queryType === "LIST_ROWS" && ast.selectColumns.length) {
        const selectList = ast.selectColumns
            .map((c) => `${c.expression} AS ${c.alias}`)
            .join(", ");
        const orderBy = ast.orderBy.length
            ? ` ORDER BY ${ast.orderBy
                  .map((o) => `${o.expression} ${o.direction}`)
                  .join(", ")}`
            : "";
        const limit = ast.limit ? ` LIMIT ${ast.limit}` : "";
        return `SELECT ${selectList} FROM features WHERE ${where}${orderBy}${limit}`;
    }

    return null;
}
