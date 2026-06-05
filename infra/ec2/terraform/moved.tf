moved {
  from = aws_instance.app
  to   = aws_instance.primary
}

moved {
  from = aws_eip.app[0]
  to   = aws_eip.primary[0]
}

moved {
  from = aws_eip_association.app[0]
  to   = aws_eip_association.primary[0]
}
