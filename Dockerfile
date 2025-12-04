# ---------- BUILDER ----------
    FROM node:20-alpine AS builder

    WORKDIR /app
    
    COPY package*.json ./
    RUN npm ci --legacy-peer-deps
    
    COPY . .
    RUN npm run build
    
    # ---------- PRODUCTION ----------
    FROM node:20-alpine AS production
    
    WORKDIR /app
    
    # Copie uniquement le fichier lock généré par le builder
    COPY package.json package-lock.json ./
    
    # Installer uniquement les dépendances prod + ignorer peer-conflicts
    RUN npm ci --omit=dev --legacy-peer-deps
    
    # Copier les fichiers buildés
    COPY --from=builder /app/dist ./dist
    
    EXPOSE 4000
    
    CMD ["node", "dist/main"]
    