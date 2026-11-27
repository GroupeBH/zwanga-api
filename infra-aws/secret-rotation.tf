# Defaults preserve current behavior. Changing these controls never generates a
# new secret by itself; use reviewed -replace plans for the exact random_password.
variable "redis_auth_token_update_strategy" {
  description = "ROTATE adds a token; SET revokes the previous token after client cutover. Never use DELETE."
  type        = string
  default     = "ROTATE"
  validation {
    condition     = contains(["ROTATE", "SET"], var.redis_auth_token_update_strategy)
    error_message = "Redis auth strategy must be ROTATE or SET; disabling authentication is forbidden."
  }
}

variable "redis_apply_immediately" {
  description = "Apply Redis changes immediately during an approved intervention; review ALL pending changes first."
  type        = bool
  default     = false
}
