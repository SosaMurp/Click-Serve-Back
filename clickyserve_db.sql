--
-- PostgreSQL database dump
--

\restrict v9vKzz7iRgMeyFvoNQdhZ1Q72nwH5Ac1iTSVx33wAtjksZGxiNbslVcxaEL71w5

-- Dumped from database version 18.3
-- Dumped by pg_dump version 18.3

-- Started on 2026-09-17 08:34:06

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
-- TOC entry 2 (class 3079 OID 25001)
-- Name: pgcrypto; Type: EXTENSION; Schema: -; Owner: -
--

CREATE EXTENSION IF NOT EXISTS pgcrypto WITH SCHEMA public;


--
-- TOC entry 5117 (class 0 OID 0)
-- Dependencies: 2
-- Name: EXTENSION pgcrypto; Type: COMMENT; Schema: -; Owner: 
--

COMMENT ON EXTENSION pgcrypto IS 'cryptographic functions';


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- TOC entry 225 (class 1259 OID 16630)
-- Name: permiso; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.permiso (
    id_permiso integer NOT NULL,
    clave_permiso character varying(50) NOT NULL,
    descripcion text
);


ALTER TABLE public.permiso OWNER TO postgres;

--
-- TOC entry 224 (class 1259 OID 16629)
-- Name: permiso_id_permiso_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.permiso_id_permiso_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.permiso_id_permiso_seq OWNER TO postgres;

--
-- TOC entry 5118 (class 0 OID 0)
-- Dependencies: 224
-- Name: permiso_id_permiso_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.permiso_id_permiso_seq OWNED BY public.permiso.id_permiso;


--
-- TOC entry 221 (class 1259 OID 16597)
-- Name: rol; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.rol (
    id_rol integer NOT NULL,
    nombre_rol character varying(50) NOT NULL
);


ALTER TABLE public.rol OWNER TO postgres;

--
-- TOC entry 220 (class 1259 OID 16596)
-- Name: rol_id_rol_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.rol_id_rol_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.rol_id_rol_seq OWNER TO postgres;

--
-- TOC entry 5119 (class 0 OID 0)
-- Dependencies: 220
-- Name: rol_id_rol_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.rol_id_rol_seq OWNED BY public.rol.id_rol;


--
-- TOC entry 227 (class 1259 OID 16643)
-- Name: rol_permiso; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.rol_permiso (
    id_rol_permiso integer NOT NULL,
    id_rol integer,
    id_permiso integer
);


ALTER TABLE public.rol_permiso OWNER TO postgres;

--
-- TOC entry 226 (class 1259 OID 16642)
-- Name: rol_permiso_id_rol_permiso_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.rol_permiso_id_rol_permiso_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.rol_permiso_id_rol_permiso_seq OWNER TO postgres;

--
-- TOC entry 5120 (class 0 OID 0)
-- Dependencies: 226
-- Name: rol_permiso_id_rol_permiso_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.rol_permiso_id_rol_permiso_seq OWNED BY public.rol_permiso.id_rol_permiso;


--
-- TOC entry 230 (class 1259 OID 16691)
-- Name: sesiones_activas; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.sesiones_activas (
    id_sesion uuid DEFAULT gen_random_uuid() NOT NULL,
    id_usuario integer,
    dispositivo character varying(255),
    fecha_creacion timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    estado character varying(20) DEFAULT 'activa'::character varying,
    id_rol integer
);


ALTER TABLE public.sesiones_activas OWNER TO postgres;

--
-- TOC entry 229 (class 1259 OID 16661)
-- Name: tokens_temporales; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.tokens_temporales (
    id_token integer NOT NULL,
    token character varying(10) NOT NULL,
    tipo_accion character varying(50) NOT NULL,
    fecha_creacion timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    fecha_expiracion timestamp without time zone DEFAULT (CURRENT_TIMESTAMP + '00:15:00'::interval),
    estado_uso character varying(20) DEFAULT 'sin usar'::character varying,
    id_usuario integer NOT NULL
);


ALTER TABLE public.tokens_temporales OWNER TO postgres;

--
-- TOC entry 228 (class 1259 OID 16660)
-- Name: tokens_temporales_id_token_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.tokens_temporales_id_token_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.tokens_temporales_id_token_seq OWNER TO postgres;

--
-- TOC entry 5121 (class 0 OID 0)
-- Dependencies: 228
-- Name: tokens_temporales_id_token_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.tokens_temporales_id_token_seq OWNED BY public.tokens_temporales.id_token;


--
-- TOC entry 223 (class 1259 OID 16606)
-- Name: usuarios; Type: TABLE; Schema: public; Owner: postgres
--

CREATE TABLE public.usuarios (
    id_usuario integer NOT NULL,
    nombre character varying(100) NOT NULL,
    apellido character varying(100) NOT NULL,
    correo character varying(150) NOT NULL,
    contrasena character varying(255) NOT NULL,
    fecha_registro timestamp without time zone DEFAULT CURRENT_TIMESTAMP,
    estado_cuenta character varying(20) DEFAULT 'Activo'::character varying,
    fecha_nacimiento date,
    telefono character varying(15),
    url_ine_front text,
    url_ine_rev text,
    fecha_actualizacion_contrasena timestamp without time zone,
    "2FA_Activo" boolean DEFAULT false,
    "2FA_Sem" character varying(255),
    id_rol integer,
    version_sesion integer DEFAULT 1
);


ALTER TABLE public.usuarios OWNER TO postgres;

--
-- TOC entry 222 (class 1259 OID 16605)
-- Name: usuarios_id_usuario_seq; Type: SEQUENCE; Schema: public; Owner: postgres
--

CREATE SEQUENCE public.usuarios_id_usuario_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE public.usuarios_id_usuario_seq OWNER TO postgres;

--
-- TOC entry 5122 (class 0 OID 0)
-- Dependencies: 222
-- Name: usuarios_id_usuario_seq; Type: SEQUENCE OWNED BY; Schema: public; Owner: postgres
--

ALTER SEQUENCE public.usuarios_id_usuario_seq OWNED BY public.usuarios.id_usuario;


--
-- TOC entry 4924 (class 2604 OID 16633)
-- Name: permiso id_permiso; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.permiso ALTER COLUMN id_permiso SET DEFAULT nextval('public.permiso_id_permiso_seq'::regclass);


--
-- TOC entry 4918 (class 2604 OID 16600)
-- Name: rol id_rol; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rol ALTER COLUMN id_rol SET DEFAULT nextval('public.rol_id_rol_seq'::regclass);


--
-- TOC entry 4925 (class 2604 OID 16646)
-- Name: rol_permiso id_rol_permiso; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rol_permiso ALTER COLUMN id_rol_permiso SET DEFAULT nextval('public.rol_permiso_id_rol_permiso_seq'::regclass);


--
-- TOC entry 4926 (class 2604 OID 16664)
-- Name: tokens_temporales id_token; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tokens_temporales ALTER COLUMN id_token SET DEFAULT nextval('public.tokens_temporales_id_token_seq'::regclass);


--
-- TOC entry 4919 (class 2604 OID 16609)
-- Name: usuarios id_usuario; Type: DEFAULT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.usuarios ALTER COLUMN id_usuario SET DEFAULT nextval('public.usuarios_id_usuario_seq'::regclass);


--
-- TOC entry 5106 (class 0 OID 16630)
-- Dependencies: 225
-- Data for Name: permiso; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.permiso (id_permiso, clave_permiso, descripcion) FROM stdin;
\.


--
-- TOC entry 5102 (class 0 OID 16597)
-- Dependencies: 221
-- Data for Name: rol; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.rol (id_rol, nombre_rol) FROM stdin;
1	Cliente
2	Tecnico
3	Admin
\.


--
-- TOC entry 5108 (class 0 OID 16643)
-- Dependencies: 227
-- Data for Name: rol_permiso; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.rol_permiso (id_rol_permiso, id_rol, id_permiso) FROM stdin;
\.


--
-- TOC entry 5111 (class 0 OID 16691)
-- Dependencies: 230
-- Data for Name: sesiones_activas; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.sesiones_activas (id_sesion, id_usuario, dispositivo, fecha_creacion, estado, id_rol) FROM stdin;
644a9ad2-4c34-4aca-a913-1dad519a7425	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-01 12:47:57.435178	revocada	3
95ef7368-8be4-405c-bdac-8c5f8b829476	18	Expo/1017756 CFNetwork/3860.500.112 Darwin/25.4.0	2026-05-18 20:53:44.529459	activa	\N
b11074d3-d43d-4930-ade9-cbd7ca2e4a98	18	okhttp/4.12.0	2026-05-18 20:54:03.434927	activa	\N
55438b78-86ea-40e3-8f21-d6b1c64985c4	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-18 23:56:39.0152	revocada	3
976a8195-1365-4d9d-9d97-0dbff106db7b	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 00:03:26.941403	revocada	3
b8d405aa-5d73-4db9-9982-14c63938fc12	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 00:08:06.299857	revocada	3
8fb5518b-20ab-4cc1-ab51-3b837f4f8b66	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 00:14:19.579115	revocada	3
ff6cf0bf-fa48-432a-99fd-383034ca2efe	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-18 23:36:21.68738	revocada	3
7bab587b-c58c-4a16-ad73-2b7c3059d778	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-18 23:34:06.761815	revocada	3
ebdf1b16-aa6b-4807-88b9-2ff5cff24079	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 00:15:12.735941	revocada	3
90780dba-520c-4327-a280-1ba31849234a	18	Expo/1017756 CFNetwork/3860.500.112 Darwin/25.4.0	2026-05-18 22:13:38.658114	revocada	2
e31a9dc8-e32a-44a4-b520-4bceae76b181	27	Expo/1017756 CFNetwork/3860.500.112 Darwin/25.4.0	2026-05-19 02:24:30.310803	revocada	1
cc40a9b0-f1c1-4ccf-91bb-d7625bb0032a	27	okhttp/4.12.0	2026-05-19 02:28:09.551935	revocada	1
401e3c5d-7fc1-4571-9e3f-b4a0cc458103	27	okhttp/4.12.0	2026-05-19 02:39:01.212115	revocada	1
a4dcdb15-9396-41c3-9a88-1a2e3389352b	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 03:06:08.705522	revocada	3
715c3e55-a807-4dca-b0a5-e6b683a9f463	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 00:24:59.851608	revocada	3
4a120f8e-3d35-4d49-a7d6-9b9201868961	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 00:42:36.291788	revocada	3
1affb3e1-e008-443f-b1da-4549440a3fb0	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 00:43:10.896514	revocada	3
b8686668-4852-4ddb-a3f9-86fd8a923737	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 00:43:45.73489	revocada	3
3a380d9d-e1ab-4816-9044-c3005d112cb9	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-05-19 03:07:44.003448	revocada	3
ab2bbc58-4321-4b46-83ad-978760ffb91f	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-01 11:35:42.981227	revocada	3
cfcbce23-dc15-40f0-a528-93592bde5f87	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-01 11:36:29.350509	revocada	3
c17395d5-f78f-4a8b-a0a1-ea50f2d1322e	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-02 08:24:21.1335	revocada	1
12a51840-9993-4a84-b220-cf4ec844873a	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-02 08:33:00.103789	revocada	1
0bde94d6-948a-473d-afe1-7fa9068cd6fc	27	Expo/1017756 CFNetwork/3860.500.112 Darwin/25.4.0	2026-05-19 02:35:32.184164	revocada	1
1fffa1c7-42a8-4943-9847-d877026b1be3	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-01 19:44:21.612927	revocada	1
57fbab20-fb11-4134-9f1a-f99daa35405f	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-01 19:47:20.465609	revocada	1
b45be04e-55cf-46ec-bc42-82ceccdd0257	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-01 19:49:54.947065	revocada	1
fdd89d25-af74-4ac4-b9a6-a3069e790461	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-02 08:36:23.542236	revocada	1
f44b8fc4-5eb0-47f2-a3a4-2b280a13e214	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-02 21:58:11.747123	revocada	1
3b129e40-d96a-4726-8be3-45d61dbdc015	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-02 22:16:03.714527	revocada	1
9d25512c-9438-4148-a00e-daec4b76678b	18	Expo/1017756 CFNetwork/3860.500.112 Darwin/25.4.0	2026-05-19 02:22:13.845868	revocada	2
319118c7-f19b-49fd-a07b-80f6abc14c15	18	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-01 19:45:31.339181	revocada	2
4fcdb39f-e66b-4712-8d96-5dd6c64cb775	18	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-01 19:51:11.200828	revocada	2
a784b970-a7eb-41f7-8740-7c4297c2e131	18	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-02 08:31:33.769929	revocada	2
3ae73b9e-052f-4ff9-b772-db6ef2cb4399	18	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-02 21:56:36.729366	revocada	2
a6cdd1e6-cb38-4d27-b070-506101ecc36f	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-03 07:22:58.167114	revocada	1
324631cc-f959-44c0-aad8-63f9eab7a04e	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-03 08:58:39.938798	revocada	1
5edc24ac-74c5-4555-ba5a-c7dabde15d24	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-03 10:53:18.279414	revocada	1
11f7c943-bdec-4bd8-bfa4-e00abf40a072	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-03 10:55:11.593552	revocada	1
06f8d168-1b0e-4e47-9e0b-bbcb8d6461cd	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-03 11:01:19.965608	revocada	1
9c21f8b9-1ba7-4ed8-9366-c9a0adcf66d8	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-03 11:07:36.165469	revocada	1
ba6bbc2e-b2d0-4211-a22b-5d73c0bb39a1	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-03 11:08:59.65552	revocada	1
8c5a337c-3c70-45b3-9b97-1c04968ffbe0	18	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-03 07:23:41.24053	revocada	2
e6109666-dc78-4b58-9b6c-e62a51045a18	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-03 08:03:31.853607	revocada	3
72337b11-2063-4120-b6cb-a0d1d578a3c7	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-01 12:57:48.845702	revocada	3
bef03483-b87d-4f58-adc8-c5886b0d4923	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-03 11:46:24.126575	revocada	1
663f7f62-7dce-4260-9ebe-f395c84c4514	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-03 11:47:20.144855	revocada	1
c5b2c37d-918d-4cf3-bc2c-04c59f5ec1ca	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-03 11:48:40.982314	revocada	1
b4f1a3ac-d0ab-4bcf-af9d-f5ff8a163e94	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-03 11:48:43.675631	revocada	1
490d9c1d-37ee-42b0-b5d1-2d9de55e1a58	27	Expo/1017756 CFNetwork/3860.300.31 Darwin/25.2.0	2026-06-03 12:42:32.361508	revocada	1
8ee9e254-89b2-4e45-aec0-96de98ee70ef	27	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-03 12:43:31.319983	revocada	1
5e9ffb03-73e1-458f-8500-a873f16cc979	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-03 12:45:06.565787	activa	3
a2013f63-94fe-4584-bb04-a1001619e995	18	Expo/1017756 CFNetwork/3860.600.12 Darwin/25.5.0	2026-06-03 12:45:00.078653	revocada	2
432c9e56-106d-4ba8-bc8d-96c4e8be65b0	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-03 11:33:55.336289	revocada	3
b459dfe9-4668-4f17-9ad8-d7e00c9acb59	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-03 08:05:06.785198	revocada	3
8d270246-5bfe-49a9-9699-faa0ebf6ce72	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-03 08:05:54.38323	revocada	3
df427a81-5ae4-440c-87d1-14a82c121d92	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-03 08:06:21.512584	revocada	3
55a43621-18df-461d-a8b3-a5f7093210a8	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 OPR/131.0.0.0	2026-06-03 08:06:44.519398	revocada	3
56b07c5e-03db-4998-9fc0-cc87f409ac7a	26	Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36 OPR/134.0.0.0	2026-08-27 10:13:55.263286	activa	3
\.


--
-- TOC entry 5110 (class 0 OID 16661)
-- Dependencies: 229
-- Data for Name: tokens_temporales; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.tokens_temporales (id_token, token, tipo_accion, fecha_creacion, fecha_expiracion, estado_uso, id_usuario) FROM stdin;
48	8283	recuperacion	2026-06-02 22:14:53.208983	2026-06-02 22:29:53.208983	expirado	27
49	6948	recuperacion	2026-06-02 22:16:17.5951	2026-06-02 22:31:17.5951	expirado	27
12	4491	registro	2026-05-17 15:23:26.217377	2026-05-17 15:38:26.217377	expirado	18
13	2976	registro	2026-05-17 15:23:47.265311	2026-05-17 15:38:47.265311	usado	18
14	8975	registro	2026-05-17 15:28:03.523948	2026-05-17 15:43:03.523948	sin usar	19
15	2680	registro	2026-05-17 15:29:04.783824	2026-05-17 15:44:04.783824	sin usar	20
16	4707	registro	2026-05-17 15:30:32.435119	2026-05-17 15:45:32.435119	sin usar	21
17	5253	registro	2026-05-17 15:41:52.854866	2026-05-17 15:56:52.854866	sin usar	22
18	6752	registro	2026-05-17 15:42:43.256436	2026-05-17 15:57:43.256436	sin usar	23
50	1689	recuperacion	2026-06-02 22:17:13.185875	2026-06-02 22:32:13.185875	usado	27
51	4004	recuperacion	2026-06-03 07:24:47.324324	2026-06-03 07:39:47.324324	expirado	27
19	5479	recuperacion	2026-05-17 19:40:21.092217	2026-05-17 19:55:21.092217	usado	18
52	3176	recuperacion	2026-06-03 07:28:05.912107	2026-06-03 07:43:05.912107	usado	27
25	724568	login_admin	2026-05-19 00:19:15.161735	2026-05-19 00:34:15.161735	expirado	26
26	544397	login_admin	2026-05-19 00:24:28.077455	2026-05-19 00:39:28.077455	usado	26
27	239435	login_admin	2026-05-19 00:41:59.440539	2026-05-19 00:56:59.440539	usado	26
28	934648	login_admin	2026-05-19 00:42:57.034185	2026-05-19 00:57:57.034185	usado	26
29	630801	login_admin	2026-05-19 00:43:32.50569	2026-05-19 00:58:32.50569	usado	26
30	9140	registro	2026-05-19 02:17:01.609068	2026-05-19 02:32:01.609068	usado	27
31	9505	recuperacion	2026-05-19 02:21:03.244371	2026-05-19 02:36:03.244371	sin usar	18
32	1763	recuperacion	2026-05-19 02:21:26.089451	2026-05-19 02:36:26.089451	verificado	18
20	7931	recuperacion	2026-05-17 19:42:34.750471	2026-05-17 19:57:34.750471	usado	18
53	375023	login_admin	2026-06-03 07:56:45.166174	2026-06-03 08:11:45.166174	expirado	26
35	4638	registro	2026-05-19 02:59:23.076076	2026-05-19 03:14:23.076076	expirado	30
36	4606	registro	2026-05-19 02:59:48.581664	2026-05-19 03:14:48.581664	usado	30
37	830614	login_admin	2026-05-19 03:05:38.335998	2026-05-19 03:20:38.335998	usado	26
38	883972	login_admin	2026-05-19 03:07:13.754927	2026-05-19 03:22:13.754927	usado	26
39	296344	login_admin	2026-06-01 11:35:13.324436	2026-06-01 11:50:13.324436	usado	26
40	978058	login_admin	2026-06-01 11:36:09.681662	2026-06-01 11:51:09.681662	usado	26
41	571624	login_admin	2026-06-01 12:47:43.495172	2026-06-01 13:02:43.495172	usado	26
42	828262	login_admin	2026-06-01 12:57:13.707998	2026-06-01 13:12:13.707998	usado	26
43	2084	recuperacion	2026-06-01 19:38:50.107856	2026-06-01 19:53:50.107856	usado	27
44	7676	recuperacion	2026-06-01 19:44:48.468922	2026-06-01 19:59:48.468922	verificado	18
21	7421	recuperacion	2026-05-17 19:54:17.959719	2026-05-17 20:09:17.959719	usado	18
54	894920	login_admin	2026-06-03 07:58:11.05306	2026-06-03 08:13:11.05306	expirado	26
47	1770	recuperacion	2026-06-02 21:57:02.880424	2026-06-02 22:12:02.880424	usado	27
45	1051	recuperacion	2026-06-02 21:54:45.368604	2026-06-02 22:09:45.368604	expirado	27
46	3240	recuperacion	2026-06-02 21:55:48.086897	2026-06-02 22:10:48.086897	expirado	27
55	912786	login_admin	2026-06-03 08:03:17.83997	2026-06-03 08:18:17.83997	usado	26
56	363938	login_admin	2026-06-03 08:04:53.912765	2026-06-03 08:19:53.912765	usado	26
57	897990	login_admin	2026-06-03 08:05:41.38358	2026-06-03 08:20:41.38358	usado	26
58	472235	login_admin	2026-06-03 08:06:08.976762	2026-06-03 08:21:08.976762	usado	26
59	449879	login_admin	2026-06-03 08:06:32.219386	2026-06-03 08:21:32.219386	usado	26
60	2382	recuperacion	2026-06-03 10:55:40.179021	2026-06-03 11:10:40.179021	expirado	27
61	2821	recuperacion	2026-06-03 11:10:05.926644	2026-06-03 11:25:05.926644	usado	27
62	413315	login_admin	2026-06-03 11:33:26.443824	2026-06-03 11:48:26.443824	usado	26
63	450872	login_admin	2026-06-03 12:40:53.546656	2026-06-03 12:55:53.546656	usado	26
64	1805	registro	2026-06-03 12:46:55.843071	2026-06-03 13:01:55.843071	expirado	33
65	4844	registro	2026-06-03 12:47:42.329605	2026-06-03 13:02:42.329605	sin usar	33
66	687461	login_admin	2026-08-27 10:13:15.507476	2026-08-27 10:28:15.507476	usado	26
\.


--
-- TOC entry 5104 (class 0 OID 16606)
-- Dependencies: 223
-- Data for Name: usuarios; Type: TABLE DATA; Schema: public; Owner: postgres
--

COPY public.usuarios (id_usuario, nombre, apellido, correo, contrasena, fecha_registro, estado_cuenta, fecha_nacimiento, telefono, url_ine_front, url_ine_rev, fecha_actualizacion_contrasena, "2FA_Activo", "2FA_Sem", id_rol, version_sesion) FROM stdin;
1	Paolo	Benitez	Paolo@correo.com	$2b$10$vun7NvU6LCld9wiqiKxyk.CEW8rRP/pS/dQD4e6icmE18JOO0v8je	2026-05-11 11:46:33.117458	Activo	2000-05-11	0123456789	\N	\N	\N	f	\N	1	1
2	Paola	Perez	Paola@correo.com	$2b$10$0DKx9InT/.gB3lcCUZXn.ucINJyFYaqsVW7WUYGCoFOmiN8xyv3Ti	2026-05-11 11:51:14.8175	Activo	2000-05-12	1234567890	\N	\N	\N	f	\N	2	1
3	Juan	Perez	Juan@corre.com	$2b$10$64YKIVF8vUSZknhTWEi/EeMtBlqiCHTruQ9k.D.r.0HMWSByr/raC	2026-05-11 12:33:07.595834	Activo	2010-05-11	9876543210	\N	\N	\N	f	\N	1	1
4	Pedro	Perez	Pedro@correo.com	$2b$10$FRRAcT5n1LQ1EcVgKtcrxeCbXFNqAwleT0BKRxdm1EBW/Spv3ul/.	2026-05-11 12:34:23.654299	Activo	1985-02-06	1234567890	\N	\N	\N	f	\N	2	1
5	Arnoldo	Paez	Paez@correoreal.com	$2b$10$VgmAJJRFzvjREK9eWf6Bren17hf/jeDWT.xu8coVAdecqcCvYf.oO	2026-05-15 18:58:35.754522	Activo	2007-05-16	124567890	\N	\N	\N	f	\N	1	1
19	X	D	sincorreo@sincorreo.com	$2b$10$HLv3flTJ0WmIhywqm9WITutLPU7u1pT.wo.Un2DgTR1bJ.U4DRqoC	2026-05-17 15:28:03.520326	No verificado	2002-07-22	1234567890	\N	\N	\N	f	\N	1	1
20	juan	perez	correo.com	$2b$10$t4ebSZVwIzva8oZFKZvHZu9SonEtOtW0uo4KmoiBi1nc6aAAT2LW.	2026-05-17 15:29:04.777502	No verificado	2007-05-05	1289374650	\N	\N	\N	f	\N	1	1
21	Gerardo	Perez	correo@correo.com	$2b$10$0XLfvpA8g.436VQli5bxq.6J5ZCPIBl4xZ3KC4GK8JfroGlz/gyha	2026-05-17 15:30:32.430106	No verificado	2007-05-05	1289374650	\N	\N	\N	f	\N	1	1
22	xavi	Perre	nuevocorreo@nuevocorreo.com	$2b$10$s8v9r/Zd9/twqcUVK7Y1eeXxnyoTp9AObMXIz7GFTIIYaIjwjs8CC	2026-05-17 15:41:52.835834	No verificado	2003-07-26	1234567890	\N	\N	\N	f	\N	1	1
23	xavi	Perre	paolo@correo.com	$2b$10$HHRNgyimvlL2b82XO.shG.4OwBXgzV69uVN3/O4IfMoJGVzRU4EXy	2026-05-17 15:42:43.25087	No verificado	2003-07-26	1234567890	\N	\N	\N	f	\N	1	1
30	Artemio	Mora	ezequiel_artemio@hotmail.com	$2b$10$UhspKX4IpQLQEH3BDxuptO.b8OS2C0SVAf0Wt3yks3lv7/wbNvxRu	2026-05-19 02:59:23.072737	Activo	1998-09-17	1234567890	\N	\N	\N	f	\N	1	1
18	Ezequiel	Vazquez	zequivz@outlook.com	$2b$10$nrwE5wMtX3eSXOSqtIkTrOffX83X2toCkTw1fuZDrHxDeBbujmODa	2026-05-17 15:23:26.201844	Activo	2003-05-28	1234567890	\N	\N	\N	f	\N	2	6
27	Ezequiel	Sosa	zequivz@hotmail.com	$2b$10$Qc0tbX9iTFGPneaufqn1.O7Q08/T2KaAwHOiTF6Z.Scshuj5Vl3Be	2026-05-19 02:17:01.604553	Activo	2003-05-28	7531538556	\N	\N	\N	f	\N	1	11
33	Juan	Perez	psg.project@outlook.es	$2b$10$o2nN0vEG6BgAvRThBOBNCepyf5ZCj7bySRUHtmKQkJ4mL5j2Ay5hC	2026-06-03 12:46:55.793648	No verificado	2003-05-28	1234567890	\N	\N	\N	f	\N	1	1
26	Alejandro	Ramírez	zequivz@gmail.com	$2a$10$9Z.zfR46V01OEnGeb3tym.mfQb.tK.BzRREJXOJsOlZp9tTXw0nGi	2026-05-18 23:32:35.315884	Activo	1990-01-01	7894561230	\N	\N	\N	f	\N	3	1
\.


--
-- TOC entry 5123 (class 0 OID 0)
-- Dependencies: 224
-- Name: permiso_id_permiso_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.permiso_id_permiso_seq', 1, false);


--
-- TOC entry 5124 (class 0 OID 0)
-- Dependencies: 220
-- Name: rol_id_rol_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.rol_id_rol_seq', 3, true);


--
-- TOC entry 5125 (class 0 OID 0)
-- Dependencies: 226
-- Name: rol_permiso_id_rol_permiso_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.rol_permiso_id_rol_permiso_seq', 1, false);


--
-- TOC entry 5126 (class 0 OID 0)
-- Dependencies: 228
-- Name: tokens_temporales_id_token_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.tokens_temporales_id_token_seq', 66, true);


--
-- TOC entry 5127 (class 0 OID 0)
-- Dependencies: 222
-- Name: usuarios_id_usuario_seq; Type: SEQUENCE SET; Schema: public; Owner: postgres
--

SELECT pg_catalog.setval('public.usuarios_id_usuario_seq', 33, true);


--
-- TOC entry 4940 (class 2606 OID 16641)
-- Name: permiso permiso_clave_permiso_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.permiso
    ADD CONSTRAINT permiso_clave_permiso_key UNIQUE (clave_permiso);


--
-- TOC entry 4942 (class 2606 OID 16639)
-- Name: permiso permiso_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.permiso
    ADD CONSTRAINT permiso_pkey PRIMARY KEY (id_permiso);


--
-- TOC entry 4944 (class 2606 OID 16649)
-- Name: rol_permiso rol_permiso_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rol_permiso
    ADD CONSTRAINT rol_permiso_pkey PRIMARY KEY (id_rol_permiso);


--
-- TOC entry 4934 (class 2606 OID 16604)
-- Name: rol rol_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rol
    ADD CONSTRAINT rol_pkey PRIMARY KEY (id_rol);


--
-- TOC entry 4948 (class 2606 OID 16699)
-- Name: sesiones_activas sesiones_activas_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sesiones_activas
    ADD CONSTRAINT sesiones_activas_pkey PRIMARY KEY (id_sesion);


--
-- TOC entry 4946 (class 2606 OID 16673)
-- Name: tokens_temporales tokens_temporales_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tokens_temporales
    ADD CONSTRAINT tokens_temporales_pkey PRIMARY KEY (id_token);


--
-- TOC entry 4936 (class 2606 OID 16623)
-- Name: usuarios usuarios_correo_key; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_correo_key UNIQUE (correo);


--
-- TOC entry 4938 (class 2606 OID 16621)
-- Name: usuarios usuarios_pkey; Type: CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_pkey PRIMARY KEY (id_usuario);


--
-- TOC entry 4952 (class 2606 OID 16674)
-- Name: tokens_temporales fk_usuario; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.tokens_temporales
    ADD CONSTRAINT fk_usuario FOREIGN KEY (id_usuario) REFERENCES public.usuarios(id_usuario) ON DELETE CASCADE;


--
-- TOC entry 4950 (class 2606 OID 16655)
-- Name: rol_permiso rol_permiso_id_permiso_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rol_permiso
    ADD CONSTRAINT rol_permiso_id_permiso_fkey FOREIGN KEY (id_permiso) REFERENCES public.permiso(id_permiso) ON DELETE CASCADE;


--
-- TOC entry 4951 (class 2606 OID 16650)
-- Name: rol_permiso rol_permiso_id_rol_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.rol_permiso
    ADD CONSTRAINT rol_permiso_id_rol_fkey FOREIGN KEY (id_rol) REFERENCES public.rol(id_rol) ON DELETE CASCADE;


--
-- TOC entry 4953 (class 2606 OID 16700)
-- Name: sesiones_activas sesiones_activas_id_usuario_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.sesiones_activas
    ADD CONSTRAINT sesiones_activas_id_usuario_fkey FOREIGN KEY (id_usuario) REFERENCES public.usuarios(id_usuario) ON DELETE CASCADE;


--
-- TOC entry 4949 (class 2606 OID 16624)
-- Name: usuarios usuarios_id_rol_fkey; Type: FK CONSTRAINT; Schema: public; Owner: postgres
--

ALTER TABLE ONLY public.usuarios
    ADD CONSTRAINT usuarios_id_rol_fkey FOREIGN KEY (id_rol) REFERENCES public.rol(id_rol);


-- Completed on 2026-09-17 08:34:06

--
-- PostgreSQL database dump complete
--

\unrestrict v9vKzz7iRgMeyFvoNQdhZ1Q72nwH5Ac1iTSVx33wAtjksZGxiNbslVcxaEL71w5

