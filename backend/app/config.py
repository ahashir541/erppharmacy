from functools import lru_cache
from pathlib import Path
from typing import Annotated

from pydantic import EmailStr, Field, SecretStr, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=Path(__file__).resolve().parents[2] / ".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    database_url: str = "sqlite:///./medical_erp.db"
    jwt_secret_key: SecretStr = SecretStr("")
    access_token_minutes: int = Field(default=30, ge=5, le=1440)
    bootstrap_admin_email: EmailStr | None = None
    bootstrap_admin_password: SecretStr | None = None
    bootstrap_admin_name: str = "Syed Hashir Ali"
    bootstrap_store_name: str = "Medical Store"
    bootstrap_platform_email: EmailStr | None = None
    bootstrap_platform_password: SecretStr | None = None
    bootstrap_platform_name: str = "Syed Hashir Ali"
    billing_jazzcash_account_name: str = ""
    billing_jazzcash_account_number: str = ""
    billing_easypaisa_account_name: str = ""
    billing_easypaisa_account_number: str = ""
    billing_bank_name: str = ""
    billing_bank_account_title: str = ""
    billing_bank_account_number: str = ""
    billing_bank_iban: str = ""
    environment: str = "development"
    trusted_host_origins: Annotated[list[str], NoDecode] = [
        "localhost",
        "127.0.0.1",
        "testserver",
    ]
    cors_origins: Annotated[list[str], NoDecode] = ["http://localhost:5173"]

    @field_validator("jwt_secret_key")
    @classmethod
    def validate_jwt_secret(cls, value: SecretStr) -> SecretStr:
        if len(value.get_secret_value()) < 32:
            raise ValueError("JWT_SECRET_KEY must contain at least 32 characters.")
        return value

    @field_validator("environment")
    @classmethod
    def validate_environment(cls, value: str) -> str:
        environment = value.strip().lower()
        if environment not in {"development", "test", "production"}:
            raise ValueError("ENVIRONMENT must be development, test, or production.")
        return environment

    @field_validator("trusted_host_origins", "cors_origins", mode="before")
    @classmethod
    def split_origins(cls, value: list[str] | str) -> list[str]:
        if isinstance(value, str):
            origins = [origin.strip() for origin in value.split(",") if origin.strip()]
            if not origins:
                raise ValueError("At least one trusted host and CORS origin must be configured.")
            return origins
        return value

    @model_validator(mode="after")
    def validate_production_settings(self) -> "Settings":
        if self.environment == "production":
            if not self.database_url.startswith(("postgresql://", "postgresql+psycopg://")):
                raise ValueError("Production must use PostgreSQL, not SQLite.")
            if not self.bootstrap_platform_email or not self.bootstrap_platform_password:
                raise ValueError("Production requires bootstrap platform operator credentials.")
            if len(self.bootstrap_platform_password.get_secret_value()) < 14:
                raise ValueError("The platform operator password must be at least 14 characters.")
            if not self.trusted_host_origins or any(
                host in {"*", "localhost", "127.0.0.1"} for host in self.trusted_host_origins
            ):
                raise ValueError("Production requires explicit public trusted host names.")
            if not self.cors_origins or any(
                origin.startswith("http://") or origin == "*" for origin in self.cors_origins
            ):
                raise ValueError("Production CORS origins must be explicit HTTPS origins.")
        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()


settings = get_settings()
