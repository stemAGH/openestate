import { Injectable, type CallHandler, type ExecutionContext, type NestInterceptor } from '@nestjs/common';
import { map, type Observable } from 'rxjs';
import { stripRestrictedFields } from '@openestate/shared';

/**
 * Drops restricted identifier fields (see RESTRICTED_FIELDS) from every
 * JSON response, at any depth, so no endpoint, present or future, can
 * return them: only the masked value leaves the server. This also cleans
 * audit rows stored by older releases on the way out.
 *
 * ponytail: handlers that write the response themselves (@Res(), e.g. the
 * report CSV/JSON streams) bypass interceptors; none of them select these
 * fields. Strip there too if one ever does.
 */
@Injectable()
export class RestrictedFieldsInterceptor implements NestInterceptor {
  intercept(_ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    return next.handle().pipe(map((body) => stripRestrictedFields(body)));
  }
}
