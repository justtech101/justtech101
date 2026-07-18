import uuid
from datetime import datetime
from typing import Any

from pydantic import BaseModel, ConfigDict, EmailStr


class ProfileBase(BaseModel):
    display_name: str
    full_name: str
    email: EmailStr
    phone: str | None = None
    address: dict[str, Any] = {}
    links: dict[str, Any] = {}
    skills: list[str] = []
    education: list[dict[str, Any]] = []
    work_history: list[dict[str, Any]] = []
    eligibility: dict[str, Any] = {}
    preferences: dict[str, Any] = {}


class ProfileCreate(ProfileBase):
    pass


class ProfileUpdate(BaseModel):
    display_name: str | None = None
    full_name: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    address: dict[str, Any] | None = None
    links: dict[str, Any] | None = None
    skills: list[str] | None = None
    education: list[dict[str, Any]] | None = None
    work_history: list[dict[str, Any]] | None = None
    eligibility: dict[str, Any] | None = None
    preferences: dict[str, Any] | None = None
    is_active: bool | None = None


class ProfileOut(ProfileBase):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    is_active: bool
    created_at: datetime
    updated_at: datetime


class ReusableAnswerCreate(BaseModel):
    question_text: str
    answer_text: str
    category: str | None = None
    verified: bool = False


class ReusableAnswerOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)
    id: uuid.UUID
    profile_id: uuid.UUID
    question_hash: str
    question_text: str
    answer_text: str
    category: str | None
    verified: bool
    verified_at: datetime | None
    created_at: datetime
