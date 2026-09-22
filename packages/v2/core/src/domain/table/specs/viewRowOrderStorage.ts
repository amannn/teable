import { flattenAndSpecs } from '../../shared/specification/composeAndSpecs';
import type { ISpecification } from '../../shared/specification/ISpecification';
import type { Table } from '../Table';
import { TableAddViewSpec } from './TableAddViewSpec';
import { TableEnsureViewRowOrderSpec } from './TableEnsureViewRowOrderSpec';
import type { ITableSpecVisitor } from './ITableSpecVisitor';

/**
 * Grid views whose `__row_<viewId>` column must exist before the request
 * transaction. Non-grid views have no row-order column.
 */
export const viewIdsNeedingRowOrderStorage = (
  spec: ISpecification<Table, ITableSpecVisitor> | undefined
): string[] => {
  const seen = new Set<string>();
  const viewIds: string[] = [];
  for (const item of flattenAndSpecs(spec)) {
    const view =
      item instanceof TableAddViewSpec || item instanceof TableEnsureViewRowOrderSpec
        ? item.view()
        : undefined;
    if (!view || view.type().toString() !== 'grid') {
      continue;
    }
    const viewId = view.id().toString();
    if (seen.has(viewId)) {
      continue;
    }
    seen.add(viewId);
    viewIds.push(viewId);
  }
  return viewIds;
};
