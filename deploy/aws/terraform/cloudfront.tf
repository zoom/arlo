resource "random_password" "cloudfront_origin_secret" {
  length  = 32
  special = false
}

resource "aws_cloudfront_response_headers_policy" "security" {
  name    = "${local.name}-security-headers"
  comment = "OWASP security headers required by Zoom Apps"

  security_headers_config {
    content_security_policy {
      content_security_policy = "default-src 'self'; script-src 'self' https://appssdk.zoom.us 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src 'self' data:; img-src 'self' data: https:; connect-src 'self' https: wss:; frame-src 'self' https://appssdk.zoom.us https://*.zoom.us https://*.zoomgov.com; frame-ancestors 'self' https://zoom.us https://*.zoom.us https://zoomgov.com https://*.zoomgov.com; object-src 'none'; base-uri 'self'; form-action 'self' https://zoom.us https://*.zoom.us https://zoomgov.com https://*.zoomgov.com"
      override                = true
    }

    content_type_options {
      override = true
    }

    referrer_policy {
      referrer_policy = "strict-origin-when-cross-origin"
      override        = true
    }

    strict_transport_security {
      access_control_max_age_sec = 31536000
      include_subdomains         = true
      preload                    = false
      override                   = true
    }
  }

  custom_headers_config {
    items {
      header   = "Permissions-Policy"
      value    = "camera=(), microphone=(), geolocation=()"
      override = true
    }
  }
}

resource "aws_cloudfront_distribution" "app" {
  enabled         = true
  is_ipv6_enabled = true
  price_class     = "PriceClass_100"
  comment         = "Arlo ${var.environment} HTTPS entrypoint"

  origin {
    domain_name = aws_lb.app.dns_name
    origin_id   = "${local.name}-alb"

    custom_header {
      name  = "x-arlo-origin-secret"
      value = random_password.cloudfront_origin_secret.result
    }

    custom_origin_config {
      http_port              = 80
      https_port             = 443
      origin_protocol_policy = "http-only"
      origin_ssl_protocols   = ["TLSv1.2"]
    }
  }

  default_cache_behavior {
    target_origin_id           = "${local.name}-alb"
    viewer_protocol_policy     = "redirect-to-https"
    response_headers_policy_id = aws_cloudfront_response_headers_policy.security.id
    allowed_methods            = ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"]
    cached_methods             = ["GET", "HEAD", "OPTIONS"]
    compress                   = true

    forwarded_values {
      query_string = true
      headers      = ["*"]

      cookies {
        forward = "all"
      }
    }

    min_ttl     = 0
    default_ttl = 0
    max_ttl     = 0
  }

  restrictions {
    geo_restriction {
      restriction_type = "none"
    }
  }

  viewer_certificate {
    cloudfront_default_certificate = true
  }

  tags = merge(local.tags, {
    Name = "${local.name}-https"
  })
}
