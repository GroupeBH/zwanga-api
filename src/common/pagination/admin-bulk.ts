import { HttpException } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';
import {
  ArrayMaxSize,
  ArrayMinSize,
  ArrayUnique,
  IsArray,
  IsUUID,
} from 'class-validator';

export class AdminBulkIdsDto {
  @ApiProperty({ type: [String], minItems: 1, maxItems: 50 })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @ArrayUnique()
  @IsUUID('all', { each: true })
  ids: string[];
}
/** Each item uses the existing business transaction; partial success is explicit. */
export async function runAdminBulk(
  ids: string[],
  action: (id: string) => Promise<unknown>,
) {
  const results: Array<{
    id: string;
    success: boolean;
    statusCode?: number;
    message?: string;
  }> = [];
  for (const id of ids) {
    try {
      await action(id);
      results.push({ id, success: true });
    } catch (error) {
      const statusCode =
        error instanceof HttpException ? error.getStatus() : 500;
      results.push({
        id,
        success: false,
        statusCode,
        message:
          statusCode < 500
            ? error.message
            : 'Opération non aboutie. Vérifiez son état avant de réessayer.',
      });
    }
  }
  return {
    results,
    total: results.length,
    succeeded: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
  };
}
