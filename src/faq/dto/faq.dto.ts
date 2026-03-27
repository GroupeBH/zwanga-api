import {
  IsBoolean,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Min,
} from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';

export class CreateFaqEntryDto {
  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  question: string;

  @ApiProperty()
  @IsString()
  @IsNotEmpty()
  answer: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiProperty({ required: false, default: 'fr-CD' })
  @IsString()
  @IsOptional()
  locale?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  audience?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  keywords?: string;

  @ApiProperty({ required: false, default: true })
  @IsBoolean()
  @IsOptional()
  isPublished?: boolean = true;

  @ApiProperty({ required: false, default: 0 })
  @IsInt()
  @IsOptional()
  order?: number = 0;
}

export class UpdateFaqEntryDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  question?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  answer?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  locale?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  audience?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  keywords?: string;

  @ApiProperty({ required: false })
  @IsBoolean()
  @IsOptional()
  isPublished?: boolean;

  @ApiProperty({ required: false })
  @IsInt()
  @IsOptional()
  order?: number;
}

export class ListFaqQueryDto {
  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  category?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  search?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  locale?: string;

  @ApiProperty({ required: false })
  @IsString()
  @IsOptional()
  audience?: string;

  @ApiProperty({ required: false, default: 1 })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Min(1)
  page?: number = 1;

  @ApiProperty({ required: false, default: 20 })
  @Type(() => Number)
  @IsInt()
  @IsOptional()
  @Min(1)
  limit?: number = 20;
}

