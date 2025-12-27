import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { FavoritePlace } from './entities/favorite-place.entity';
import { FavoritePlacesService } from './favorite-places.service';
import { FavoritePlacesController } from './favorite-places.controller';
import { CommonModule } from '../common/common.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([FavoritePlace]),
    CommonModule,
  ],
  controllers: [FavoritePlacesController],
  providers: [FavoritePlacesService],
  exports: [FavoritePlacesService],
})
export class FavoritePlacesModule {}

