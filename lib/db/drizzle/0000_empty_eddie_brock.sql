CREATE TABLE "users" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text,
	"email" text NOT NULL,
	"name" text,
	"password_hash" text,
	"email_verified_at" timestamp with time zone,
	"verify_token" text,
	"verify_token_expires_at" timestamp with time zone,
	"reset_token" text,
	"reset_token_expires_at" timestamp with time zone,
	"is_super_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"timezone" text DEFAULT 'Asia/Kolkata' NOT NULL,
	"gst_number" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"state" text,
	"postal_code" text,
	"country" text DEFAULT 'India',
	"logo_url" text,
	"invoice_footer" text,
	"plan" text DEFAULT 'free' NOT NULL,
	"subscription_status" text DEFAULT 'trialing' NOT NULL,
	"razorpay_customer_id" text,
	"razorpay_subscription_id" text,
	"current_period_end" timestamp with time zone,
	"trial_ends_at" timestamp with time zone,
	"shopify_shop_domain" text,
	"shopify_access_token" text,
	"shopify_scopes" text,
	"shopify_location_id" text,
	"shopify_webhook_registered_at" timestamp with time zone,
	"shopify_last_webhook_at" timestamp with time zone,
	"shopify_last_synced_at" timestamp with time zone,
	"shopify_product_count" text,
	"shopify_last_order_id" text,
	"shiprocket_email" text,
	"shiprocket_token_encrypted" text,
	"shiprocket_token_expires_at" timestamp with time zone,
	"shiprocket_pickup_pincode" text,
	"shiprocket_last_synced_at" timestamp with time zone,
	"ewb_gstin" text,
	"ewb_api_username" text,
	"ewb_api_password_encrypted" text,
	"ewb_token_encrypted" text,
	"ewb_token_expires_at" timestamp with time zone,
	"ewb_connected_at" timestamp with time zone,
	"ewb_last_error_at" timestamp with time zone,
	"ewb_last_error_message" text,
	"e_invoice_enabled" boolean DEFAULT false NOT NULL,
	"e_invoice_gstin" text,
	"e_invoice_api_username" text,
	"e_invoice_api_password_encrypted" text,
	"e_invoice_client_id_encrypted" text,
	"e_invoice_client_secret_encrypted" text,
	"e_invoice_token_encrypted" text,
	"e_invoice_token_expires_at" timestamp with time zone,
	"e_invoice_connected_at" timestamp with time zone,
	"e_invoice_last_error_at" timestamp with time zone,
	"e_invoice_last_error_message" text,
	"barcode_prefix" text,
	"barcode_format" text DEFAULT 'code128' NOT NULL,
	"onboarding_completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_members" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" integer NOT NULL,
	"organization_id" integer NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "warehouses" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"code" text NOT NULL,
	"address_line1" text,
	"city" text,
	"state" text,
	"country" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"is_virtual" boolean DEFAULT false NOT NULL,
	"job_worker_supplier_id" integer,
	"shopify_location_id" text,
	"shopify_location_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "items" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"sku" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"category" text,
	"unit" text DEFAULT 'pcs' NOT NULL,
	"barcode" text,
	"barcode_source" text,
	"sale_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"purchase_price" numeric(14, 2) DEFAULT '0' NOT NULL,
	"hsn_code" text,
	"tax_rate" numeric(6, 2) DEFAULT '0' NOT NULL,
	"reorder_level" numeric(14, 2) DEFAULT '0' NOT NULL,
	"image_url" text,
	"parent_item_id" integer,
	"has_variants" boolean DEFAULT false NOT NULL,
	"is_bundle" boolean DEFAULT false NOT NULL,
	"is_bag" boolean DEFAULT false NOT NULL,
	"allow_backorder" boolean DEFAULT false NOT NULL,
	"track_batches" boolean DEFAULT false NOT NULL,
	"variant_options" jsonb,
	"shopify_product_id" text,
	"shopify_variant_id" text,
	"shopify_inventory_item_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "item_bundle_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"parent_item_id" integer NOT NULL,
	"component_item_id" integer NOT NULL,
	"quantity_per_bundle" numeric(14, 2) DEFAULT '1' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_warehouse_stock" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"quantity" numeric(14, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_batches" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"batch_number" text NOT NULL,
	"mfg_date" date,
	"expiry_date" date,
	"cost_price" numeric(14, 2),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_batch_warehouse_stock" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"item_batch_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"quantity" numeric(14, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"company" text,
	"gst_number" text,
	"billing_address" text,
	"shipping_address" text,
	"place_of_supply" text,
	"notes" text,
	"outstanding_balance" numeric(14, 2) DEFAULT '0' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "suppliers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"name" text NOT NULL,
	"email" text,
	"phone" text,
	"company" text,
	"gst_number" text,
	"address" text,
	"notes" text,
	"outstanding_payable" numeric(14, 2) DEFAULT '0' NOT NULL,
	"is_job_worker" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"sales_order_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"description" text,
	"quantity" numeric(14, 2) NOT NULL,
	"quantity_shipped" numeric(14, 2) DEFAULT '0' NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"tax_rate" numeric(6, 2) DEFAULT '0' NOT NULL,
	"discount_percent" numeric(6, 2) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"line_subtotal" numeric(14, 2) NOT NULL,
	"line_tax" numeric(14, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sales_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"order_number" text NOT NULL,
	"customer_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"order_date" date NOT NULL,
	"expected_ship_date" date,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"balance_due" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"stock_applied_at" timestamp with time zone,
	"shopify_order_id" text,
	"external_reference" text,
	"ewb_number" text,
	"ewb_date" timestamp with time zone,
	"ewb_valid_until" timestamp with time zone,
	"ewb_status" text,
	"ewb_qr_payload" text,
	"ewb_vehicle_number" text,
	"ewb_transport_mode" text,
	"ewb_transporter_name" text,
	"ewb_transporter_id" text,
	"ewb_distance_km" integer,
	"ewb_dispatch_address" jsonb,
	"ewb_ship_to_address" jsonb,
	"ewb_cancelled_at" timestamp with time zone,
	"ewb_cancel_reason" text,
	"irn" text,
	"irp_ack_number" text,
	"irp_ack_date" timestamp with time zone,
	"irp_qr_payload" text,
	"irp_status" text,
	"irp_error" text,
	"irp_error_code" text,
	"irp_error_context" jsonb,
	"irp_cancelled_at" timestamp with time zone,
	"irp_cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_payment_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"sales_order_id" integer NOT NULL,
	"amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"customer_id" integer NOT NULL,
	"payment_date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"mode" text NOT NULL,
	"reference_number" text,
	"notes" text,
	"bank_account_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_order_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"description" text,
	"quantity" numeric(14, 2) NOT NULL,
	"unit_price" numeric(14, 2) NOT NULL,
	"tax_rate" numeric(6, 2) DEFAULT '0' NOT NULL,
	"discount_percent" numeric(6, 2) DEFAULT '0' NOT NULL,
	"discount_amount" numeric(14, 2) DEFAULT '0' NOT NULL,
	"line_subtotal" numeric(14, 2) NOT NULL,
	"line_tax" numeric(14, 2) NOT NULL,
	"line_total" numeric(14, 2) NOT NULL,
	"quantity_received" numeric(14, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"order_number" text NOT NULL,
	"supplier_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"order_date" date NOT NULL,
	"expected_delivery_date" date,
	"subtotal" numeric(14, 2) DEFAULT '0' NOT NULL,
	"tax_total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"total" numeric(14, 2) DEFAULT '0' NOT NULL,
	"amount_paid" numeric(14, 2) DEFAULT '0' NOT NULL,
	"balance_due" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"stock_applied_at" timestamp with time zone,
	"job_work_receipt_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_payment_allocations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"payment_id" integer NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"amount" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "supplier_payments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"supplier_id" integer NOT NULL,
	"payment_date" date NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"mode" text NOT NULL,
	"reference_number" text,
	"notes" text,
	"bank_account_label" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipment_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"shipment_id" integer NOT NULL,
	"sales_order_line_id" integer NOT NULL,
	"quantity" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shipments" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"sales_order_id" integer NOT NULL,
	"shipment_number" text NOT NULL,
	"ship_date" date NOT NULL,
	"status" text DEFAULT 'shipped' NOT NULL,
	"notes" text,
	"shiprocket_order_id" text,
	"shiprocket_shipment_id" text,
	"awb" text,
	"courier_name" text,
	"label_url" text,
	"tracking_url" text,
	"tracking_status" text,
	"last_tracked_at" timestamp with time zone,
	"cancel_reason_code" text,
	"cancel_reason_notes" text,
	"cancelled_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipt_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"goods_receipt_id" integer NOT NULL,
	"purchase_order_line_id" integer NOT NULL,
	"quantity" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "goods_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"purchase_order_id" integer NOT NULL,
	"receipt_number" text NOT NULL,
	"received_date" date NOT NULL,
	"status" text DEFAULT 'received' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_transfer_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"stock_transfer_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"quantity" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_transfers" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"transfer_number" text NOT NULL,
	"from_warehouse_id" integer NOT NULL,
	"to_warehouse_id" integer NOT NULL,
	"transfer_date" date NOT NULL,
	"status" text DEFAULT 'draft' NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"item_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"movement_type" text NOT NULL,
	"quantity" numeric(14, 2) NOT NULL,
	"reference_type" text,
	"reference_id" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_work_issue_lines" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"job_work_issue_id" integer NOT NULL,
	"component_item_id" integer NOT NULL,
	"quantity" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_work_issues" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"job_work_order_id" integer NOT NULL,
	"issue_number" text NOT NULL,
	"issue_date" date NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_work_order_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"job_work_order_id" integer NOT NULL,
	"component_item_id" integer NOT NULL,
	"quantity_per_output" numeric(14, 2) NOT NULL,
	"total_quantity" numeric(14, 2) NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_work_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"jwo_number" text NOT NULL,
	"supplier_id" integer NOT NULL,
	"output_item_id" integer NOT NULL,
	"output_quantity" numeric(14, 2) NOT NULL,
	"source_warehouse_id" integer NOT NULL,
	"dest_warehouse_id" integer NOT NULL,
	"vendor_warehouse_id" integer NOT NULL,
	"job_charge_rate" numeric(14, 2) DEFAULT '0' NOT NULL,
	"expected_return_date" date,
	"notes" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_work_receipt_components" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"job_work_receipt_id" integer NOT NULL,
	"component_item_id" integer NOT NULL,
	"quantity_consumed" numeric(14, 2) NOT NULL,
	"scrap_quantity" numeric(14, 2) DEFAULT '0' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "job_work_receipts" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"job_work_order_id" integer NOT NULL,
	"receipt_number" text NOT NULL,
	"received_date" date NOT NULL,
	"finished_quantity" numeric(14, 2) NOT NULL,
	"scrap_quantity" numeric(14, 2) DEFAULT '0' NOT NULL,
	"job_charge" numeric(14, 2) DEFAULT '0' NOT NULL,
	"notes" text,
	"status" text DEFAULT 'recorded' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_batch_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"stock_movement_id" integer NOT NULL,
	"item_batch_id" integer NOT NULL,
	"warehouse_id" integer NOT NULL,
	"quantity" numeric(14, 2) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "team_invitations" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"email" text NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"token" text NOT NULL,
	"invited_by_user_id" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_oauth_states" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"state" text NOT NULL,
	"shop_domain" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shopify_webhook_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"shopify_event_id" text NOT NULL,
	"topic" text NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"sales_order_id" integer,
	"kind" text NOT NULL,
	"recipient" text NOT NULL,
	"subject" text NOT NULL,
	"status" text NOT NULL,
	"error_message" text,
	"sent_by_user_id" integer,
	"sent_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "email_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"host" text NOT NULL,
	"port" integer NOT NULL,
	"secure" text DEFAULT 'starttls' NOT NULL,
	"username" text NOT NULL,
	"password_encrypted" text NOT NULL,
	"from_email" text NOT NULL,
	"from_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_settings_organization_id_unique" UNIQUE("organization_id")
);
--> statement-breakpoint
CREATE TABLE "payment_links" (
	"id" serial PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"sales_order_id" integer NOT NULL,
	"razorpay_link_id" text NOT NULL,
	"short_url" text NOT NULL,
	"amount" numeric(14, 2) NOT NULL,
	"currency" text DEFAULT 'INR' NOT NULL,
	"status" text DEFAULT 'created' NOT NULL,
	"description" text,
	"razorpay_payment_id" text,
	"expires_at" timestamp with time zone,
	"paid_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"created_by_user_id" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "einvoice_bulk_batches" (
	"id" varchar PRIMARY KEY NOT NULL,
	"organization_id" integer NOT NULL,
	"status" text NOT NULL,
	"total" integer DEFAULT 0 NOT NULL,
	"processed" integer DEFAULT 0 NOT NULL,
	"succeeded" integer DEFAULT 0 NOT NULL,
	"failed" integer DEFAULT 0 NOT NULL,
	"skipped" integer DEFAULT 0 NOT NULL,
	"order_ids_in_order" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"results" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	"concurrency" integer DEFAULT 1 NOT NULL,
	"recovery_claimed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_members" ADD CONSTRAINT "organization_members_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "warehouses" ADD CONSTRAINT "warehouses_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "items" ADD CONSTRAINT "items_parent_item_id_items_id_fk" FOREIGN KEY ("parent_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_bundle_components" ADD CONSTRAINT "item_bundle_components_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_bundle_components" ADD CONSTRAINT "item_bundle_components_parent_item_id_items_id_fk" FOREIGN KEY ("parent_item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_bundle_components" ADD CONSTRAINT "item_bundle_components_component_item_id_items_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_warehouse_stock" ADD CONSTRAINT "item_warehouse_stock_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_warehouse_stock" ADD CONSTRAINT "item_warehouse_stock_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_warehouse_stock" ADD CONSTRAINT "item_warehouse_stock_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_batches" ADD CONSTRAINT "item_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_batches" ADD CONSTRAINT "item_batches_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_batch_warehouse_stock" ADD CONSTRAINT "item_batch_warehouse_stock_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_batch_warehouse_stock" ADD CONSTRAINT "item_batch_warehouse_stock_item_batch_id_item_batches_id_fk" FOREIGN KEY ("item_batch_id") REFERENCES "public"."item_batches"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "item_batch_warehouse_stock" ADD CONSTRAINT "item_batch_warehouse_stock_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "suppliers" ADD CONSTRAINT "suppliers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_order_lines" ADD CONSTRAINT "sales_order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_orders" ADD CONSTRAINT "sales_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_allocations" ADD CONSTRAINT "customer_payment_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_allocations" ADD CONSTRAINT "customer_payment_allocations_payment_id_customer_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."customer_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payment_allocations" ADD CONSTRAINT "customer_payment_allocations_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_payments" ADD CONSTRAINT "customer_payments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_lines" ADD CONSTRAINT "purchase_order_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_job_work_receipt_id_job_work_receipts_id_fk" FOREIGN KEY ("job_work_receipt_id") REFERENCES "public"."job_work_receipts"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_payment_id_supplier_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."supplier_payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_shipment_id_shipments_id_fk" FOREIGN KEY ("shipment_id") REFERENCES "public"."shipments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipment_lines" ADD CONSTRAINT "shipment_lines_sales_order_line_id_sales_order_lines_id_fk" FOREIGN KEY ("sales_order_line_id") REFERENCES "public"."sales_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shipments" ADD CONSTRAINT "shipments_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_goods_receipt_id_goods_receipts_id_fk" FOREIGN KEY ("goods_receipt_id") REFERENCES "public"."goods_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipt_lines" ADD CONSTRAINT "goods_receipt_lines_purchase_order_line_id_purchase_order_lines_id_fk" FOREIGN KEY ("purchase_order_line_id") REFERENCES "public"."purchase_order_lines"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "goods_receipts" ADD CONSTRAINT "goods_receipts_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_stock_transfer_id_stock_transfers_id_fk" FOREIGN KEY ("stock_transfer_id") REFERENCES "public"."stock_transfers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfer_lines" ADD CONSTRAINT "stock_transfer_lines_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_from_warehouse_id_warehouses_id_fk" FOREIGN KEY ("from_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_to_warehouse_id_warehouses_id_fk" FOREIGN KEY ("to_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_item_id_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_movements" ADD CONSTRAINT "stock_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_issue_lines" ADD CONSTRAINT "job_work_issue_lines_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_issue_lines" ADD CONSTRAINT "job_work_issue_lines_job_work_issue_id_job_work_issues_id_fk" FOREIGN KEY ("job_work_issue_id") REFERENCES "public"."job_work_issues"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_issue_lines" ADD CONSTRAINT "job_work_issue_lines_component_item_id_items_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_issues" ADD CONSTRAINT "job_work_issues_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_issues" ADD CONSTRAINT "job_work_issues_job_work_order_id_job_work_orders_id_fk" FOREIGN KEY ("job_work_order_id") REFERENCES "public"."job_work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_order_components" ADD CONSTRAINT "job_work_order_components_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_order_components" ADD CONSTRAINT "job_work_order_components_job_work_order_id_job_work_orders_id_fk" FOREIGN KEY ("job_work_order_id") REFERENCES "public"."job_work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_order_components" ADD CONSTRAINT "job_work_order_components_component_item_id_items_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_supplier_id_suppliers_id_fk" FOREIGN KEY ("supplier_id") REFERENCES "public"."suppliers"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_output_item_id_items_id_fk" FOREIGN KEY ("output_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_source_warehouse_id_warehouses_id_fk" FOREIGN KEY ("source_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_dest_warehouse_id_warehouses_id_fk" FOREIGN KEY ("dest_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_orders" ADD CONSTRAINT "job_work_orders_vendor_warehouse_id_warehouses_id_fk" FOREIGN KEY ("vendor_warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipt_components" ADD CONSTRAINT "job_work_receipt_components_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipt_components" ADD CONSTRAINT "job_work_receipt_components_job_work_receipt_id_job_work_receipts_id_fk" FOREIGN KEY ("job_work_receipt_id") REFERENCES "public"."job_work_receipts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipt_components" ADD CONSTRAINT "job_work_receipt_components_component_item_id_items_id_fk" FOREIGN KEY ("component_item_id") REFERENCES "public"."items"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipts" ADD CONSTRAINT "job_work_receipts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_work_receipts" ADD CONSTRAINT "job_work_receipts_job_work_order_id_job_work_orders_id_fk" FOREIGN KEY ("job_work_order_id") REFERENCES "public"."job_work_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batch_movements" ADD CONSTRAINT "stock_batch_movements_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batch_movements" ADD CONSTRAINT "stock_batch_movements_stock_movement_id_stock_movements_id_fk" FOREIGN KEY ("stock_movement_id") REFERENCES "public"."stock_movements"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batch_movements" ADD CONSTRAINT "stock_batch_movements_item_batch_id_item_batches_id_fk" FOREIGN KEY ("item_batch_id") REFERENCES "public"."item_batches"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "stock_batch_movements" ADD CONSTRAINT "stock_batch_movements_warehouse_id_warehouses_id_fk" FOREIGN KEY ("warehouse_id") REFERENCES "public"."warehouses"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "team_invitations" ADD CONSTRAINT "team_invitations_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_oauth_states" ADD CONSTRAINT "shopify_oauth_states_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shopify_webhook_events" ADD CONSTRAINT "shopify_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_log" ADD CONSTRAINT "email_log_sent_by_user_id_users_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "email_settings" ADD CONSTRAINT "email_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_sales_order_id_sales_orders_id_fk" FOREIGN KEY ("sales_order_id") REFERENCES "public"."sales_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payment_links" ADD CONSTRAINT "payment_links_created_by_user_id_users_id_fk" FOREIGN KEY ("created_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "einvoice_bulk_batches" ADD CONSTRAINT "einvoice_bulk_batches_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "users_clerk_user_id_idx" ON "users" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_verify_token_idx" ON "users" USING btree ("verify_token");--> statement-breakpoint
CREATE UNIQUE INDEX "users_reset_token_idx" ON "users" USING btree ("reset_token");--> statement-breakpoint
CREATE UNIQUE INDEX "organizations_slug_idx" ON "organizations" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "org_members_user_org_idx" ON "organization_members" USING btree ("user_id","organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_org_code_idx" ON "warehouses" USING btree ("organization_id","code");--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_org_shopify_location_idx" ON "warehouses" USING btree ("organization_id","shopify_location_id") WHERE "warehouses"."shopify_location_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "warehouses_org_job_worker_idx" ON "warehouses" USING btree ("organization_id","job_worker_supplier_id") WHERE "warehouses"."is_virtual" = true;--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_sku_idx" ON "items" USING btree ("organization_id","sku") WHERE "items"."archived_at" IS NULL;--> statement-breakpoint
CREATE INDEX "items_org_parent_idx" ON "items" USING btree ("organization_id","parent_item_id");--> statement-breakpoint
CREATE INDEX "items_org_shopify_variant_idx" ON "items" USING btree ("organization_id","shopify_variant_id");--> statement-breakpoint
CREATE INDEX "items_org_barcode_idx" ON "items" USING btree ("organization_id","barcode");--> statement-breakpoint
CREATE UNIQUE INDEX "items_org_barcode_unique_idx" ON "items" USING btree ("organization_id","barcode") WHERE "items"."barcode" IS NOT NULL AND "items"."archived_at" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "item_bundle_components_parent_comp_idx" ON "item_bundle_components" USING btree ("parent_item_id","component_item_id");--> statement-breakpoint
CREATE INDEX "item_bundle_components_org_parent_idx" ON "item_bundle_components" USING btree ("organization_id","parent_item_id");--> statement-breakpoint
CREATE INDEX "item_bundle_components_org_comp_idx" ON "item_bundle_components" USING btree ("organization_id","component_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_warehouse_stock_idx" ON "item_warehouse_stock" USING btree ("item_id","warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "item_batches_item_batchno_idx" ON "item_batches" USING btree ("item_id","batch_number");--> statement-breakpoint
CREATE INDEX "item_batches_org_item_idx" ON "item_batches" USING btree ("organization_id","item_id");--> statement-breakpoint
CREATE INDEX "item_batches_org_expiry_idx" ON "item_batches" USING btree ("organization_id","expiry_date");--> statement-breakpoint
CREATE UNIQUE INDEX "item_batch_wh_stock_idx" ON "item_batch_warehouse_stock" USING btree ("item_batch_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "item_batch_wh_stock_wh_idx" ON "item_batch_warehouse_stock" USING btree ("warehouse_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_org_number_idx" ON "sales_orders" USING btree ("organization_id","order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_orders_org_shopify_order_idx" ON "sales_orders" USING btree ("organization_id","shopify_order_id");--> statement-breakpoint
CREATE INDEX "customer_payment_allocations_payment_idx" ON "customer_payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "customer_payment_allocations_so_idx" ON "customer_payment_allocations" USING btree ("sales_order_id");--> statement-breakpoint
CREATE INDEX "customer_payment_allocations_org_idx" ON "customer_payment_allocations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "customer_payments_org_customer_idx" ON "customer_payments" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "customer_payments_org_date_idx" ON "customer_payments" USING btree ("organization_id","payment_date");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_org_number_idx" ON "purchase_orders" USING btree ("organization_id","order_number");--> statement-breakpoint
CREATE UNIQUE INDEX "purchase_orders_org_jw_receipt_idx" ON "purchase_orders" USING btree ("organization_id","job_work_receipt_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_allocations_payment_idx" ON "supplier_payment_allocations" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_allocations_po_idx" ON "supplier_payment_allocations" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "supplier_payment_allocations_org_idx" ON "supplier_payment_allocations" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_org_supplier_idx" ON "supplier_payments" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE INDEX "supplier_payments_org_date_idx" ON "supplier_payments" USING btree ("organization_id","payment_date");--> statement-breakpoint
CREATE INDEX "shipment_lines_shipment_idx" ON "shipment_lines" USING btree ("shipment_id");--> statement-breakpoint
CREATE INDEX "shipment_lines_org_line_idx" ON "shipment_lines" USING btree ("organization_id","sales_order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "shipments_org_number_idx" ON "shipments" USING btree ("organization_id","shipment_number");--> statement-breakpoint
CREATE INDEX "shipments_org_order_idx" ON "shipments" USING btree ("organization_id","sales_order_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_receipt_idx" ON "goods_receipt_lines" USING btree ("goods_receipt_id");--> statement-breakpoint
CREATE INDEX "goods_receipt_lines_org_line_idx" ON "goods_receipt_lines" USING btree ("organization_id","purchase_order_line_id");--> statement-breakpoint
CREATE UNIQUE INDEX "goods_receipts_org_number_idx" ON "goods_receipts" USING btree ("organization_id","receipt_number");--> statement-breakpoint
CREATE INDEX "goods_receipts_org_order_idx" ON "goods_receipts" USING btree ("organization_id","purchase_order_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_lines_transfer_idx" ON "stock_transfer_lines" USING btree ("stock_transfer_id");--> statement-breakpoint
CREATE INDEX "stock_transfer_lines_org_item_idx" ON "stock_transfer_lines" USING btree ("organization_id","item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "stock_transfers_org_number_idx" ON "stock_transfers" USING btree ("organization_id","transfer_number");--> statement-breakpoint
CREATE INDEX "stock_transfers_org_from_idx" ON "stock_transfers" USING btree ("organization_id","from_warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_org_to_idx" ON "stock_transfers" USING btree ("organization_id","to_warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_transfers_org_status_idx" ON "stock_transfers" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "job_work_issue_lines_issue_idx" ON "job_work_issue_lines" USING btree ("job_work_issue_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_work_issue_lines_issue_comp_idx" ON "job_work_issue_lines" USING btree ("job_work_issue_id","component_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_work_issues_org_number_idx" ON "job_work_issues" USING btree ("organization_id","issue_number");--> statement-breakpoint
CREATE INDEX "job_work_issues_jwo_idx" ON "job_work_issues" USING btree ("job_work_order_id");--> statement-breakpoint
CREATE INDEX "job_work_order_components_org_jwo_idx" ON "job_work_order_components" USING btree ("organization_id","job_work_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_work_order_components_jwo_comp_idx" ON "job_work_order_components" USING btree ("job_work_order_id","component_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_work_orders_org_number_idx" ON "job_work_orders" USING btree ("organization_id","jwo_number");--> statement-breakpoint
CREATE INDEX "job_work_orders_org_supplier_idx" ON "job_work_orders" USING btree ("organization_id","supplier_id");--> statement-breakpoint
CREATE INDEX "job_work_orders_org_status_idx" ON "job_work_orders" USING btree ("organization_id","status");--> statement-breakpoint
CREATE INDEX "job_work_receipt_components_receipt_idx" ON "job_work_receipt_components" USING btree ("job_work_receipt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_work_receipt_components_receipt_comp_idx" ON "job_work_receipt_components" USING btree ("job_work_receipt_id","component_item_id");--> statement-breakpoint
CREATE UNIQUE INDEX "job_work_receipts_org_number_idx" ON "job_work_receipts" USING btree ("organization_id","receipt_number");--> statement-breakpoint
CREATE INDEX "job_work_receipts_jwo_idx" ON "job_work_receipts" USING btree ("job_work_order_id");--> statement-breakpoint
CREATE INDEX "stock_batch_mvts_movement_idx" ON "stock_batch_movements" USING btree ("stock_movement_id");--> statement-breakpoint
CREATE INDEX "stock_batch_mvts_batch_wh_idx" ON "stock_batch_movements" USING btree ("item_batch_id","warehouse_id");--> statement-breakpoint
CREATE INDEX "stock_batch_mvts_org_idx" ON "stock_batch_movements" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "team_invitations_token_idx" ON "team_invitations" USING btree ("token");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_oauth_states_state_idx" ON "shopify_oauth_states" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "shopify_webhook_events_org_event_idx" ON "shopify_webhook_events" USING btree ("organization_id","shopify_event_id");--> statement-breakpoint
CREATE INDEX "email_log_org_sales_order_idx" ON "email_log" USING btree ("organization_id","sales_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_razorpay_link_id_idx" ON "payment_links" USING btree ("razorpay_link_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_razorpay_payment_id_idx" ON "payment_links" USING btree ("razorpay_payment_id");--> statement-breakpoint
CREATE INDEX "payment_links_org_sales_order_idx" ON "payment_links" USING btree ("organization_id","sales_order_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payment_links_active_unique_idx" ON "payment_links" USING btree ("organization_id","sales_order_id") WHERE status = 'created';--> statement-breakpoint
CREATE INDEX "einvoice_bulk_batches_status_created_idx" ON "einvoice_bulk_batches" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "einvoice_bulk_batches_org_idx" ON "einvoice_bulk_batches" USING btree ("organization_id");