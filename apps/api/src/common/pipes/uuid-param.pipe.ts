import { ArgumentMetadata, BadRequestException, Injectable, PipeTransform } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Route and query parameters that name a plugin, not a row: never UUIDs. */
const NOT_UUIDS = new Set(['pluginId']);

/**
 * Every row id in this API is a UUID. A path or query parameter called `id`
 * or `somethingId` that isn't one is refused here with a 400, before it
 * reaches the database (which would otherwise fail to cast it and answer
 * 500). Registered as APP_PIPE so it applies in main.ts and in tests that
 * bootstrap AppModule alike.
 */
@Injectable()
export class UuidParamPipe implements PipeTransform {
  transform(value: unknown, meta: ArgumentMetadata) {
    // An empty query value ("?towerId=") means "no filter", as before.
    if ((meta.type === 'param' || meta.type === 'query') && typeof meta.data === 'string' && typeof value === 'string' && value !== '') {
      const name = meta.data;
      if ((name === 'id' || name.endsWith('Id')) && !NOT_UUIDS.has(name) && !UUID.test(value)) {
        throw new BadRequestException(`${name} must be a valid id`);
      }
    }
    return value;
  }
}
