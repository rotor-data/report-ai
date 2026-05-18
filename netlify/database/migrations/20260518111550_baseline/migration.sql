-- Netlify Database baseline migration for report-ai
-- Consolidated schema snapshot from source Neon DB (pg_dump --schema-only).
-- Replaces replaying 37 legacy db/migrations/*.sql files.
-- Generated 2026-05-18 for Phase 3a (provision-only, no data, no cutover).

CREATE EXTENSION IF NOT EXISTS pgcrypto;

--
-- PostgreSQL database dump
--


-- Dumped from database version 17.8 (9c8634e)
-- Dumped by pg_dump version 17.10 (Homebrew)

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: neon_auth; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA neon_auth;


--
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: -
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


--
-- Name: doc_status; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.doc_status AS ENUM (
    'draft',
    'generating',
    'ready',
    'error'
);


--
-- Name: document_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.document_type AS ENUM (
    'annual_report',
    'quarterly',
    'pitch',
    'proposal',
    'sustainability_report',
    'board_report',
    'investor_update',
    'case_study',
    'white_paper',
    'sales_proposal',
    'project_report',
    'brand_guide',
    'product_sheet',
    'newsletter',
    'event_program',
    'company_profile',
    'ceo_letter',
    'competitive_analysis',
    'compliance_report',
    'custom',
    'impact_report',
    'internal_report',
    'market_report',
    'monthly_update',
    'onboarding_guide',
    'press_release',
    'process_doc',
    'research_report',
    'strategy_doc',
    'training_material'
);


--
-- Name: module_type; Type: TYPE; Schema: public; Owner: -
--

CREATE TYPE public.module_type AS ENUM (
    'cover',
    'chapter_break',
    'kpi_grid',
    'text_spread',
    'table',
    'quote_callout',
    'image_text',
    'data_chart',
    'two_col_text',
    'financial_summary',
    'back_cover'
);


--
-- Name: set_updated_at(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.set_updated_at() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


--
-- Name: update_blueprint_timestamp(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.update_blueprint_timestamp() RETURNS trigger
    LANGUAGE plpgsql
    AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: account; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.account (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "accountId" text NOT NULL,
    "providerId" text NOT NULL,
    "userId" uuid NOT NULL,
    "accessToken" text,
    "refreshToken" text,
    "idToken" text,
    "accessTokenExpiresAt" timestamp with time zone,
    "refreshTokenExpiresAt" timestamp with time zone,
    scope text,
    password text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL
);


--
-- Name: invitation; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.invitation (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "organizationId" uuid NOT NULL,
    email text NOT NULL,
    role text,
    status text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "inviterId" uuid NOT NULL
);


--
-- Name: jwks; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.jwks (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "publicKey" text NOT NULL,
    "privateKey" text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL,
    "expiresAt" timestamp with time zone
);


--
-- Name: member; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.member (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "organizationId" uuid NOT NULL,
    "userId" uuid NOT NULL,
    role text NOT NULL,
    "createdAt" timestamp with time zone NOT NULL
);


--
-- Name: organization; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.organization (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    slug text NOT NULL,
    logo text,
    "createdAt" timestamp with time zone NOT NULL,
    metadata text
);


--
-- Name: project_config; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.project_config (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    endpoint_id text NOT NULL,
    created_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    trusted_origins jsonb NOT NULL,
    social_providers jsonb NOT NULL,
    email_provider jsonb,
    email_and_password jsonb,
    allow_localhost boolean NOT NULL,
    plugin_configs jsonb,
    webhook_config jsonb
);


--
-- Name: session; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.session (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    token text NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone NOT NULL,
    "ipAddress" text,
    "userAgent" text,
    "userId" uuid NOT NULL,
    "impersonatedBy" text,
    "activeOrganizationId" text
);


--
-- Name: user; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth."user" (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    name text NOT NULL,
    email text NOT NULL,
    "emailVerified" boolean NOT NULL,
    image text,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    role text,
    banned boolean,
    "banReason" text,
    "banExpires" timestamp with time zone
);


--
-- Name: verification; Type: TABLE; Schema: neon_auth; Owner: -
--

CREATE TABLE neon_auth.verification (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    identifier text NOT NULL,
    value text NOT NULL,
    "expiresAt" timestamp with time zone NOT NULL,
    "createdAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    "updatedAt" timestamp with time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


--
-- Name: brand_audit_log; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_audit_log (
    id bigint NOT NULL,
    brand_id uuid NOT NULL,
    tenant_id uuid NOT NULL,
    actor text NOT NULL,
    action text NOT NULL,
    before jsonb,
    after jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brand_audit_log_id_seq; Type: SEQUENCE; Schema: public; Owner: -
--

CREATE SEQUENCE public.brand_audit_log_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


--
-- Name: brand_audit_log_id_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: -
--

ALTER SEQUENCE public.brand_audit_log_id_seq OWNED BY public.brand_audit_log.id;


--
-- Name: brand_components; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_components (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    component_type text NOT NULL,
    label text NOT NULL,
    html_template text NOT NULL,
    placeholder_schema jsonb DEFAULT '[]'::jsonb NOT NULL,
    design_notes text,
    source text,
    version integer DEFAULT 1 NOT NULL,
    is_default boolean DEFAULT false NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    extraction_id uuid,
    is_public boolean DEFAULT false NOT NULL,
    unsplash_query text,
    reference_page_numbers jsonb DEFAULT '[]'::jsonb NOT NULL,
    variant_name text DEFAULT 'Default'::text NOT NULL,
    thumbnail_url text,
    thumbnail_generated_at timestamp with time zone,
    status text DEFAULT 'draft'::text NOT NULL,
    page_format text DEFAULT 'universal'::text NOT NULL,
    css_template text,
    splittable boolean,
    harmony text[] DEFAULT '{}'::text[],
    intensity text DEFAULT 'medium'::text,
    accent_usage text DEFAULT 'tint'::text,
    content_tolerance jsonb DEFAULT '{}'::jsonb,
    chart_schema jsonb,
    chart_color_mode text DEFAULT 'brand'::text,
    style_family text,
    report_id uuid,
    CONSTRAINT brand_components_accent_usage_check CHECK ((accent_usage = ANY (ARRAY['none'::text, 'tint'::text, 'strong'::text]))),
    CONSTRAINT brand_components_chart_color_mode_check CHECK ((chart_color_mode = ANY (ARRAY['brand'::text, 'custom'::text, 'brand-locked'::text]))),
    CONSTRAINT brand_components_intensity_check CHECK ((intensity = ANY (ARRAY['quiet'::text, 'medium'::text, 'loud'::text]))),
    CONSTRAINT brand_components_source_check CHECK ((source = ANY (ARRAY['extraction'::text, 'report'::text, 'manual'::text])))
);


--
-- Name: COLUMN brand_components.report_id; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.brand_components.report_id IS 'Non-NULL for variants designed during a single reports review loop; NULL for brand-library variants.';


--
-- Name: brand_fonts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_fonts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    family text NOT NULL,
    weight integer NOT NULL,
    style text DEFAULT 'normal'::text NOT NULL,
    format text NOT NULL,
    data_base64 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brand_logos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brand_logos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    variant text NOT NULL,
    format text NOT NULL,
    data_base64 text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: brands; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.brands (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    name text NOT NULL,
    tokens jsonb DEFAULT '{}'::jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: custom_fonts; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.custom_fonts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hub_user_id text NOT NULL,
    family_name text NOT NULL,
    weight text DEFAULT '400'::text NOT NULL,
    style text DEFAULT 'normal'::text NOT NULL,
    format text NOT NULL,
    blob_key text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: design_extractions; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.design_extractions (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid NOT NULL,
    tenant_id uuid,
    label text NOT NULL,
    source_description text,
    suggested_tokens jsonb DEFAULT '{}'::jsonb NOT NULL,
    inventory jsonb DEFAULT '[]'::jsonb NOT NULL,
    reference_pages jsonb DEFAULT '[]'::jsonb NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT design_extractions_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'ready'::text, 'applied'::text, 'archived'::text])))
);


--
-- Name: document_type_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.document_type_templates (
    document_type public.document_type NOT NULL,
    required_sections jsonb NOT NULL,
    default_stub_plan jsonb NOT NULL,
    recommended_pages text,
    tone_hints text,
    disclosures jsonb DEFAULT '[]'::jsonb,
    flow_mode_default boolean DEFAULT false NOT NULL
);


--
-- Name: documents; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.documents (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hub_user_id text NOT NULL,
    title text NOT NULL,
    document_type public.document_type NOT NULL,
    status public.doc_status DEFAULT 'draft'::public.doc_status NOT NULL,
    brand_input jsonb,
    design_system jsonb,
    raw_content text,
    module_plan jsonb,
    html_output text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    deleted_at timestamp with time zone,
    pdf_output bytea
);


--
-- Name: report_blueprints; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_blueprints (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    brand_id uuid,
    name text NOT NULL,
    source_report_id uuid,
    modules jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    visibility text DEFAULT 'private'::text NOT NULL,
    owner_tenant_id uuid,
    document_type text,
    style_direction text,
    tagline text,
    chat_summary text,
    tags text[] DEFAULT '{}'::text[],
    slots jsonb,
    narrative_guidance jsonb,
    thumbnail_small_base64 text,
    thumbnail_url text,
    pages_estimate integer,
    page_format text DEFAULT 'a4_portrait'::text NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    design_system_css text,
    sample_pages_html jsonb,
    design_rules text,
    reference_source text,
    module_count integer,
    cover_thumbnail_url text,
    gallery_url text,
    gallery_generated_at timestamp with time zone,
    CONSTRAINT report_blueprints_visibility_check CHECK ((visibility = ANY (ARRAY['smyra'::text, 'tenant'::text, 'brand'::text])))
);


--
-- Name: COLUMN report_blueprints.design_system_css; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_blueprints.design_system_css IS 'alpha-v3: :root vars + class rules. Cascades via var(--brand-*) tokens.';


--
-- Name: COLUMN report_blueprints.sample_pages_html; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_blueprints.sample_pages_html IS 'alpha-v3: JSONB array of HTML strings — cover + interior samples.';


--
-- Name: COLUMN report_blueprints.design_rules; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_blueprints.design_rules IS 'alpha-v3: Claude-authored usage notes read during page_design.';


--
-- Name: COLUMN report_blueprints.reference_source; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_blueprints.reference_source IS 'alpha-v3: origin — starter_pack | extracted_from_pdf | user_created.';


--
-- Name: COLUMN report_blueprints.cover_thumbnail_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_blueprints.cover_thumbnail_url IS 'alpha-v3: URL to a PNG render of sample_pages_html[0]. Used by setup picker for at-a-glance preview.';


--
-- Name: COLUMN report_blueprints.gallery_url; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_blueprints.gallery_url IS '2x2 PNG grid of first 4 samples, generated at save time. Replaces ad-hoc thumbnail rendering in blueprint_preview pause.';


--
-- Name: COLUMN report_blueprints.gallery_generated_at; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.report_blueprints.gallery_generated_at IS 'When gallery_url was last written. NULL = needs (re)generation.';


--
-- Name: report_content_schema; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_content_schema (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    manifest_id uuid NOT NULL,
    content_schema jsonb NOT NULL,
    page_type_map jsonb NOT NULL,
    version integer DEFAULT 1 NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: report_generated_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_generated_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    page_id uuid NOT NULL,
    html_output text NOT NULL,
    svg_fragments jsonb,
    render_status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: report_manifests; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_manifests (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    hub_user_id text NOT NULL,
    source_type text NOT NULL,
    source_url text,
    blob_key text NOT NULL,
    page_count integer,
    component_inventory jsonb,
    design_tokens_extracted jsonb,
    status text DEFAULT 'pending'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT report_manifests_source_type_check CHECK ((source_type = ANY (ARRAY['url'::text, 'upload'::text])))
);


--
-- Name: report_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    manifest_id uuid NOT NULL,
    page_number integer NOT NULL,
    page_type text NOT NULL,
    layout_name text NOT NULL,
    instance_id text,
    template_html text,
    tokens jsonb,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: report_schemas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_schemas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    manifest_id uuid NOT NULL,
    hub_user_id text NOT NULL,
    company_name text,
    schema_data jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: report_templates; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.report_templates (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    document_types text[] DEFAULT ARRAY[]::text[] NOT NULL,
    css_base text NOT NULL,
    schema jsonb NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: tenant_assets; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.tenant_assets (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    filename text NOT NULL,
    mime_type text NOT NULL,
    storage_url text NOT NULL,
    width_px integer,
    height_px integer,
    size_bytes integer,
    dpi integer,
    asset_class text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT tenant_assets_asset_class_check CHECK ((asset_class = ANY (ARRAY['photo'::text, 'icon'::text, 'svg'::text])))
);


--
-- Name: v2_content_units; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.v2_content_units (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid NOT NULL,
    unit_id text NOT NULL,
    type text NOT NULL,
    level integer,
    text text,
    metadata jsonb DEFAULT '{}'::jsonb,
    order_index integer NOT NULL,
    created_at timestamp with time zone DEFAULT now(),
    updated_at timestamp with time zone DEFAULT now()
);


--
-- Name: COLUMN v2_content_units.type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.v2_content_units.type IS 'Semantic unit type. Allowed values (alpha-v3 catalogue): paragraph, lead, kicker, attribution, heading, eyebrow, blockquote, pull_quote, callout, info_box, warning_box, success_box, highlight, caption, footnote, sidenote, citation, bullet_list, numbered_list, check_list, definition_list, kpi, kpi_group, stat_hero, table, comparison, timeline_event, step, testimonial, glossary_item, divider, spacer, page_break, bibliography_entry, toc_entry.';


--
-- Name: v2_report_modules; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.v2_report_modules (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid NOT NULL,
    page_id uuid,
    module_type text NOT NULL,
    order_index integer NOT NULL,
    content jsonb NOT NULL,
    style jsonb DEFAULT '{}'::jsonb NOT NULL,
    html_cache text,
    height_mm double precision,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    html_content text,
    content_mapping jsonb,
    background jsonb DEFAULT '{}'::jsonb NOT NULL,
    CONSTRAINT v2_report_modules_module_type_check CHECK ((module_type = ANY (ARRAY['cover'::text, 'chapter_break'::text, 'back_cover'::text, 'layout'::text, 'freeform'::text])))
);


--
-- Name: COLUMN v2_report_modules.html_cache; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.v2_report_modules.html_cache IS 'Legacy: rendered HTML cache for pre-units reports. New reports use units substitution at render time so html_cache is recomputed per call. Keep for legacy fallback.';


--
-- Name: COLUMN v2_report_modules.html_content; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.v2_report_modules.html_content IS 'Legacy: inline HTML for pre-units alpha-v3 reports. New reports compose pages via data-unit refs against v2_content_units; this column is kept read-only for backwards compat and may be removed in a future cleanup pass.';


--
-- Name: v2_report_pages; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.v2_report_pages (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    report_id uuid NOT NULL,
    page_number integer NOT NULL,
    page_type text DEFAULT 'content'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    block_type text DEFAULT 'page'::text NOT NULL,
    block_index integer,
    flow_pdf_pages integer[]
);


--
-- Name: COLUMN v2_report_pages.block_type; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.v2_report_pages.block_type IS 'page = fixed 297mm canvas (original behaviour). chapter = flowing column, paginates over flow_pdf_pages via Chromium. Reflow plan 2026-05-08, Job 4.';


--
-- Name: COLUMN v2_report_pages.block_index; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.v2_report_pages.block_index IS 'Author-order index of the block (1-based). For chapter blocks this is the canonical position; flow_pdf_pages records the post-render PDF page numbers the chapter occupies.';


--
-- Name: COLUMN v2_report_pages.flow_pdf_pages; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON COLUMN public.v2_report_pages.flow_pdf_pages IS 'PDF page numbers a chapter occupies after the most recent render. Null for fixed page rows. Recomputed every render — informational, not a hard contract.';


--
-- Name: v2_reports; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.v2_reports (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    tenant_id uuid NOT NULL,
    brand_id uuid,
    template_id text,
    title text NOT NULL,
    document_type text NOT NULL,
    status text DEFAULT 'draft'::text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now() NOT NULL,
    page_format text DEFAULT 'a4_portrait'::text NOT NULL,
    document_css text,
    style_overrides jsonb DEFAULT '{}'::jsonb NOT NULL,
    document_css_overrides text
);


--
-- Name: TABLE v2_reports; Type: COMMENT; Schema: public; Owner: -
--

COMMENT ON TABLE public.v2_reports IS 'Reports for the v2/alpha pipeline. Alpha-v3 reports use v2_content_units as their canonical content store. Legacy reports keep inline HTML in v2_report_modules.html_cache.';


--
-- Name: brand_audit_log id; Type: DEFAULT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_audit_log ALTER COLUMN id SET DEFAULT nextval('public.brand_audit_log_id_seq'::regclass);


--
-- Name: account account_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.account
    ADD CONSTRAINT account_pkey PRIMARY KEY (id);


--
-- Name: invitation invitation_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.invitation
    ADD CONSTRAINT invitation_pkey PRIMARY KEY (id);


--
-- Name: jwks jwks_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.jwks
    ADD CONSTRAINT jwks_pkey PRIMARY KEY (id);


--
-- Name: member member_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.member
    ADD CONSTRAINT member_pkey PRIMARY KEY (id);


--
-- Name: organization organization_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.organization
    ADD CONSTRAINT organization_pkey PRIMARY KEY (id);


--
-- Name: organization organization_slug_key; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.organization
    ADD CONSTRAINT organization_slug_key UNIQUE (slug);


--
-- Name: project_config project_config_endpoint_id_key; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.project_config
    ADD CONSTRAINT project_config_endpoint_id_key UNIQUE (endpoint_id);


--
-- Name: project_config project_config_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.project_config
    ADD CONSTRAINT project_config_pkey PRIMARY KEY (id);


--
-- Name: session session_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.session
    ADD CONSTRAINT session_pkey PRIMARY KEY (id);


--
-- Name: session session_token_key; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.session
    ADD CONSTRAINT session_token_key UNIQUE (token);


--
-- Name: user user_email_key; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth."user"
    ADD CONSTRAINT user_email_key UNIQUE (email);


--
-- Name: user user_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth."user"
    ADD CONSTRAINT user_pkey PRIMARY KEY (id);


--
-- Name: verification verification_pkey; Type: CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.verification
    ADD CONSTRAINT verification_pkey PRIMARY KEY (id);


--
-- Name: brand_audit_log brand_audit_log_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_audit_log
    ADD CONSTRAINT brand_audit_log_pkey PRIMARY KEY (id);


--
-- Name: brand_components brand_components_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_components
    ADD CONSTRAINT brand_components_pkey PRIMARY KEY (id);


--
-- Name: brand_fonts brand_fonts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_fonts
    ADD CONSTRAINT brand_fonts_pkey PRIMARY KEY (id);


--
-- Name: brand_logos brand_logos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_logos
    ADD CONSTRAINT brand_logos_pkey PRIMARY KEY (id);


--
-- Name: brands brands_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brands
    ADD CONSTRAINT brands_pkey PRIMARY KEY (id);


--
-- Name: custom_fonts custom_fonts_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.custom_fonts
    ADD CONSTRAINT custom_fonts_pkey PRIMARY KEY (id);


--
-- Name: design_extractions design_extractions_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_extractions
    ADD CONSTRAINT design_extractions_pkey PRIMARY KEY (id);


--
-- Name: document_type_templates document_type_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.document_type_templates
    ADD CONSTRAINT document_type_templates_pkey PRIMARY KEY (document_type);


--
-- Name: documents documents_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.documents
    ADD CONSTRAINT documents_pkey PRIMARY KEY (id);


--
-- Name: report_blueprints report_blueprints_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_blueprints
    ADD CONSTRAINT report_blueprints_pkey PRIMARY KEY (id);


--
-- Name: report_content_schema report_content_schema_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_content_schema
    ADD CONSTRAINT report_content_schema_pkey PRIMARY KEY (id);


--
-- Name: report_generated_pages report_generated_pages_page_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_generated_pages
    ADD CONSTRAINT report_generated_pages_page_id_key UNIQUE (page_id);


--
-- Name: report_generated_pages report_generated_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_generated_pages
    ADD CONSTRAINT report_generated_pages_pkey PRIMARY KEY (id);


--
-- Name: report_manifests report_manifests_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_manifests
    ADD CONSTRAINT report_manifests_pkey PRIMARY KEY (id);


--
-- Name: report_pages report_pages_manifest_id_page_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_pages
    ADD CONSTRAINT report_pages_manifest_id_page_number_key UNIQUE (manifest_id, page_number);


--
-- Name: report_pages report_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_pages
    ADD CONSTRAINT report_pages_pkey PRIMARY KEY (id);


--
-- Name: report_schemas report_schemas_manifest_id_hub_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schemas
    ADD CONSTRAINT report_schemas_manifest_id_hub_user_id_key UNIQUE (manifest_id, hub_user_id);


--
-- Name: report_schemas report_schemas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schemas
    ADD CONSTRAINT report_schemas_pkey PRIMARY KEY (id);


--
-- Name: report_templates report_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_templates
    ADD CONSTRAINT report_templates_pkey PRIMARY KEY (id);


--
-- Name: tenant_assets tenant_assets_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.tenant_assets
    ADD CONSTRAINT tenant_assets_pkey PRIMARY KEY (id);


--
-- Name: v2_content_units v2_content_units_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_content_units
    ADD CONSTRAINT v2_content_units_pkey PRIMARY KEY (id);


--
-- Name: v2_content_units v2_content_units_report_id_unit_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_content_units
    ADD CONSTRAINT v2_content_units_report_id_unit_id_key UNIQUE (report_id, unit_id);


--
-- Name: v2_report_modules v2_report_modules_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_report_modules
    ADD CONSTRAINT v2_report_modules_pkey PRIMARY KEY (id);


--
-- Name: v2_report_pages v2_report_pages_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_report_pages
    ADD CONSTRAINT v2_report_pages_pkey PRIMARY KEY (id);


--
-- Name: v2_report_pages v2_report_pages_report_id_page_number_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_report_pages
    ADD CONSTRAINT v2_report_pages_report_id_page_number_key UNIQUE (report_id, page_number);


--
-- Name: v2_reports v2_reports_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_reports
    ADD CONSTRAINT v2_reports_pkey PRIMARY KEY (id);


--
-- Name: account_userId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "account_userId_idx" ON neon_auth.account USING btree ("userId");


--
-- Name: invitation_email_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX invitation_email_idx ON neon_auth.invitation USING btree (email);


--
-- Name: invitation_organizationId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "invitation_organizationId_idx" ON neon_auth.invitation USING btree ("organizationId");


--
-- Name: member_organizationId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "member_organizationId_idx" ON neon_auth.member USING btree ("organizationId");


--
-- Name: member_userId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "member_userId_idx" ON neon_auth.member USING btree ("userId");


--
-- Name: organization_slug_uidx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE UNIQUE INDEX organization_slug_uidx ON neon_auth.organization USING btree (slug);


--
-- Name: session_userId_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX "session_userId_idx" ON neon_auth.session USING btree ("userId");


--
-- Name: verification_identifier_idx; Type: INDEX; Schema: neon_auth; Owner: -
--

CREATE INDEX verification_identifier_idx ON neon_auth.verification USING btree (identifier);


--
-- Name: brand_components_report_id_idx; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX brand_components_report_id_idx ON public.brand_components USING btree (report_id) WHERE (report_id IS NOT NULL);


--
-- Name: idx_blueprints_smyra; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blueprints_smyra ON public.report_blueprints USING btree (visibility) WHERE (visibility = 'smyra'::text);


--
-- Name: idx_blueprints_v3_brand; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blueprints_v3_brand ON public.report_blueprints USING btree (brand_id) WHERE ((brand_id IS NOT NULL) AND (design_system_css IS NOT NULL));


--
-- Name: idx_blueprints_v3_smyra; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blueprints_v3_smyra ON public.report_blueprints USING btree (visibility) WHERE ((visibility = 'smyra'::text) AND (design_system_css IS NOT NULL));


--
-- Name: idx_blueprints_v3_tenant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blueprints_v3_tenant ON public.report_blueprints USING btree (owner_tenant_id, visibility) WHERE ((visibility = 'tenant'::text) AND (design_system_css IS NOT NULL));


--
-- Name: idx_blueprints_visibility_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_blueprints_visibility_type ON public.report_blueprints USING btree (visibility, document_type);


--
-- Name: idx_brand_audit_log_brand; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_audit_log_brand ON public.brand_audit_log USING btree (brand_id, created_at DESC);


--
-- Name: idx_brand_components_brand_default; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_components_brand_default ON public.brand_components USING btree (brand_id, is_default) WHERE (is_default = true);


--
-- Name: idx_brand_components_brand_type; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_components_brand_type ON public.brand_components USING btree (brand_id, component_type);


--
-- Name: idx_brand_components_extraction; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_components_extraction ON public.brand_components USING btree (extraction_id);


--
-- Name: idx_brand_components_family; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_components_family ON public.brand_components USING btree (brand_id, style_family, component_type) WHERE (style_family IS NOT NULL);


--
-- Name: idx_brand_components_has_thumb; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_components_has_thumb ON public.brand_components USING btree (brand_id, component_type) WHERE (thumbnail_url IS NOT NULL);


--
-- Name: idx_brand_components_page_format; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_components_page_format ON public.brand_components USING btree (brand_id, page_format, component_type);


--
-- Name: idx_brand_components_public; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_components_public ON public.brand_components USING btree (is_public) WHERE (is_public = true);


--
-- Name: idx_brand_components_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_components_status ON public.brand_components USING btree (brand_id, status, component_type) WHERE (status = 'ready'::text);


--
-- Name: idx_brand_components_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_components_variant ON public.brand_components USING btree (brand_id, component_type, variant_name);


--
-- Name: idx_brand_fonts_brand_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_fonts_brand_id ON public.brand_fonts USING btree (brand_id);


--
-- Name: idx_brand_logos_brand_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brand_logos_brand_id ON public.brand_logos USING btree (brand_id);


--
-- Name: idx_brands_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_brands_tenant_id ON public.brands USING btree (tenant_id);


--
-- Name: idx_design_extractions_brand; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_design_extractions_brand ON public.design_extractions USING btree (brand_id);


--
-- Name: idx_design_extractions_status; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_design_extractions_status ON public.design_extractions USING btree (status);


--
-- Name: idx_documents_user; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_documents_user ON public.documents USING btree (hub_user_id) WHERE (deleted_at IS NULL);


--
-- Name: idx_report_blueprints_brand_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_blueprints_brand_id ON public.report_blueprints USING btree (brand_id);


--
-- Name: idx_report_content_schema_manifest_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_content_schema_manifest_id ON public.report_content_schema USING btree (manifest_id);


--
-- Name: idx_report_generated_pages_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_generated_pages_page_id ON public.report_generated_pages USING btree (page_id);


--
-- Name: idx_report_manifests_hub_user_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_manifests_hub_user_id ON public.report_manifests USING btree (hub_user_id);


--
-- Name: idx_report_pages_manifest_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_pages_manifest_id ON public.report_pages USING btree (manifest_id, page_number);


--
-- Name: idx_report_schemas_manifest_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_report_schemas_manifest_id ON public.report_schemas USING btree (manifest_id);


--
-- Name: idx_tenant_assets_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_tenant_assets_tenant_id ON public.tenant_assets USING btree (tenant_id);


--
-- Name: idx_v2_content_units_report; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_v2_content_units_report ON public.v2_content_units USING btree (report_id, order_index);


--
-- Name: idx_v2_report_modules_page_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_v2_report_modules_page_id ON public.v2_report_modules USING btree (page_id);


--
-- Name: idx_v2_report_modules_report_order; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_v2_report_modules_report_order ON public.v2_report_modules USING btree (report_id, order_index);


--
-- Name: idx_v2_report_pages_report_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_v2_report_pages_report_id ON public.v2_report_pages USING btree (report_id, page_number);


--
-- Name: idx_v2_reports_brand_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_v2_reports_brand_id ON public.v2_reports USING btree (brand_id);


--
-- Name: idx_v2_reports_tenant_id; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_v2_reports_tenant_id ON public.v2_reports USING btree (tenant_id);


--
-- Name: uniq_brand_components_variant; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX uniq_brand_components_variant ON public.brand_components USING btree (brand_id, component_type, variant_name);


--
-- Name: report_blueprints blueprints_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER blueprints_updated_at BEFORE UPDATE ON public.report_blueprints FOR EACH ROW EXECUTE FUNCTION public.update_blueprint_timestamp();


--
-- Name: v2_report_modules trg_v2_report_modules_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_v2_report_modules_updated_at BEFORE UPDATE ON public.v2_report_modules FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: v2_reports trg_v2_reports_updated_at; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_v2_reports_updated_at BEFORE UPDATE ON public.v2_reports FOR EACH ROW EXECUTE FUNCTION public.set_updated_at();


--
-- Name: account account_userId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.account
    ADD CONSTRAINT "account_userId_fkey" FOREIGN KEY ("userId") REFERENCES neon_auth."user"(id) ON DELETE CASCADE;


--
-- Name: invitation invitation_inviterId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.invitation
    ADD CONSTRAINT "invitation_inviterId_fkey" FOREIGN KEY ("inviterId") REFERENCES neon_auth."user"(id) ON DELETE CASCADE;


--
-- Name: invitation invitation_organizationId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.invitation
    ADD CONSTRAINT "invitation_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES neon_auth.organization(id) ON DELETE CASCADE;


--
-- Name: member member_organizationId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.member
    ADD CONSTRAINT "member_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES neon_auth.organization(id) ON DELETE CASCADE;


--
-- Name: member member_userId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.member
    ADD CONSTRAINT "member_userId_fkey" FOREIGN KEY ("userId") REFERENCES neon_auth."user"(id) ON DELETE CASCADE;


--
-- Name: session session_userId_fkey; Type: FK CONSTRAINT; Schema: neon_auth; Owner: -
--

ALTER TABLE ONLY neon_auth.session
    ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES neon_auth."user"(id) ON DELETE CASCADE;


--
-- Name: brand_components brand_components_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_components
    ADD CONSTRAINT brand_components_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_components brand_components_extraction_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_components
    ADD CONSTRAINT brand_components_extraction_id_fkey FOREIGN KEY (extraction_id) REFERENCES public.design_extractions(id) ON DELETE SET NULL;


--
-- Name: brand_components brand_components_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_components
    ADD CONSTRAINT brand_components_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.v2_reports(id) ON DELETE CASCADE;


--
-- Name: brand_fonts brand_fonts_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_fonts
    ADD CONSTRAINT brand_fonts_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: brand_logos brand_logos_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.brand_logos
    ADD CONSTRAINT brand_logos_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: design_extractions design_extractions_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.design_extractions
    ADD CONSTRAINT design_extractions_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: report_blueprints report_blueprints_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_blueprints
    ADD CONSTRAINT report_blueprints_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE CASCADE;


--
-- Name: report_blueprints report_blueprints_source_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_blueprints
    ADD CONSTRAINT report_blueprints_source_report_id_fkey FOREIGN KEY (source_report_id) REFERENCES public.v2_reports(id) ON DELETE SET NULL;


--
-- Name: report_content_schema report_content_schema_manifest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_content_schema
    ADD CONSTRAINT report_content_schema_manifest_id_fkey FOREIGN KEY (manifest_id) REFERENCES public.report_manifests(id) ON DELETE CASCADE;


--
-- Name: report_generated_pages report_generated_pages_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_generated_pages
    ADD CONSTRAINT report_generated_pages_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.report_pages(id) ON DELETE CASCADE;


--
-- Name: report_pages report_pages_manifest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_pages
    ADD CONSTRAINT report_pages_manifest_id_fkey FOREIGN KEY (manifest_id) REFERENCES public.report_manifests(id) ON DELETE CASCADE;


--
-- Name: report_schemas report_schemas_manifest_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.report_schemas
    ADD CONSTRAINT report_schemas_manifest_id_fkey FOREIGN KEY (manifest_id) REFERENCES public.report_manifests(id) ON DELETE CASCADE;


--
-- Name: v2_content_units v2_content_units_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_content_units
    ADD CONSTRAINT v2_content_units_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.v2_reports(id) ON DELETE CASCADE;


--
-- Name: v2_report_modules v2_report_modules_page_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_report_modules
    ADD CONSTRAINT v2_report_modules_page_id_fkey FOREIGN KEY (page_id) REFERENCES public.v2_report_pages(id) ON DELETE SET NULL;


--
-- Name: v2_report_modules v2_report_modules_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_report_modules
    ADD CONSTRAINT v2_report_modules_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.v2_reports(id) ON DELETE CASCADE;


--
-- Name: v2_report_pages v2_report_pages_report_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_report_pages
    ADD CONSTRAINT v2_report_pages_report_id_fkey FOREIGN KEY (report_id) REFERENCES public.v2_reports(id) ON DELETE CASCADE;


--
-- Name: v2_reports v2_reports_brand_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_reports
    ADD CONSTRAINT v2_reports_brand_id_fkey FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE SET NULL;


--
-- Name: v2_reports v2_reports_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.v2_reports
    ADD CONSTRAINT v2_reports_template_id_fkey FOREIGN KEY (template_id) REFERENCES public.report_templates(id) ON DELETE SET NULL;


--
-- PostgreSQL database dump complete
--


